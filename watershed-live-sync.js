// ═══════════════════════════════════════════════════════════════════════════
// watershed-live-sync.js
// ═══════════════════════════════════════════════════════════════════════════
//
// The "hot" half of the hub sync story, for live-event tier datasets only
// (today: dmi-rain-history) — watershed-sync.js's own main() still handles
// the slower, static/semi-static datasets on whatever cadence its own
// caller runs it at. Two paths into the same sync+reload logic:
//
//  1. A short poll (FAST_POLL_MS), the correctness floor every replica is
//     guaranteed to hit regardless of whether it happens to receive a
//     webhook POST — Fly's load balancer only ever routes a POST to ONE
//     machine, not every replica, so this is not optional even once the
//     webhook below works.
//  2. The hub's own webhook POST (see watershed/src/webhook/notify.js on
//     the hub side) — a latency optimization for whichever one replica it
//     lands on, HMAC-verified so a spoofed POST to this public route can't
//     trigger a real fetch.
//
// Both share ONE etag cache, not two: whichever path processes an update
// first makes the other see a cheap 304, instead of the webhook path
// forcing a redundant re-download every time.
'use strict';

const crypto = require('crypto');
const { syncOne } = require('./watershed-sync');
const hubAlert = require('./hub-alert');

const HUB_URL = process.env.WATERSHED_HUB_URL;

// Comfortably under the hub's own 15-minute dmi-rain cadence — cheap
// (conditional GET, 304s cost one small round trip) even at this interval,
// same "skipped cells cost almost nothing" reasoning warmCache() already
// uses for Open-Meteo.
const FAST_POLL_MS = 90 * 1000;

function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = signatureHeader.slice('sha256='.length);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided, 'hex');
  // Length check before timingSafeEqual — that function throws on mismatched
  // lengths rather than returning false, and a malformed/short header must
  // fail closed, not crash the request handler.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// datasetHandlers: { [datasetKey]: { relativePath, onSynced() } } — onSynced
// is called only when syncOne() actually reports 'updated', never on
// 'unchanged'/'not-yet-fetched-by-hub'/'error'. Kept generic on purpose,
// same as ukwater's pipelineDataReload.js split: this module knows nothing
// about what dmi-rain-history IS, only how to sync-and-notify.
function startLiveSync(datasetHandlers, { intervalMs = FAST_POLL_MS, log = console.log, etagCache = {} } = {}) {
  if (!HUB_URL) {
    log('[watershed-live-sync] WATERSHED_HUB_URL not set — skipping');
    return { stop: () => {}, syncNow: async () => {} };
  }

  let stopped = false;

  async function pollOnce() {
    if (stopped) return;
    for (const [datasetKey, handler] of Object.entries(datasetHandlers)) {
      try {
        const result = await syncOne(datasetKey, handler.relativePath, etagCache);
        if (result.status === 'updated') {
          log(`[watershed-live-sync] ${datasetKey}: updated (${result.bytes} bytes)`);
          handler.onSynced?.();
        }
        // NYT (bruger-krav 2026-09-16) — se hub-alert.js's filhoved.
        // 'unchanged'/'updated' er begge reel succes (hub'en er oppe og har
        // svaret meningsfuldt); 'error'/'not-yet-fetched-by-hub' er degraded.
        if (result.status === 'error' || result.status === 'not-yet-fetched-by-hub') {
          hubAlert.reportHubFallback(datasetKey, `sync status '${result.status}'${result.error ? ` — ${result.error}` : ''}`, false);
        } else {
          hubAlert.reportHubRecovered(datasetKey);
        }
      } catch (err) {
        log(`[watershed-live-sync] ${datasetKey}: poll failed — ${err.message}`);
        hubAlert.reportHubFallback(datasetKey, err.message, true);
      }
    }
  }

  pollOnce();
  const timer = setInterval(pollOnce, intervalMs);
  timer.unref();
  return { stop: () => { stopped = true; clearInterval(timer); }, syncNow: pollOnce };
}

// Express route factory for the hub's webhook POST. Mounted separately from
// server.js's own express.json() middleware chain — needs the RAW body to
// verify the HMAC signature (signing happens over exact bytes on the hub
// side), so this scopes express.raw() to just this one route rather than
// touching every other route's body parsing.
function hubWebhookRouter(datasetHandlers, { secret, log = console.log, etagCache = {} } = {}) {
  const express = require('express');
  const router = express.Router();

  router.post('/internal/hub-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!secret) {
      log('[watershed-live-sync] webhook received but no secret is configured — refusing');
      res.status(503).end();
      return;
    }
    if (!verifySignature(req.body, req.headers['x-watershed-signature'], secret)) {
      log('[watershed-live-sync] webhook signature verification failed — ignoring');
      res.status(401).end();
      return;
    }

    let payload;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch {
      res.status(400).end();
      return;
    }

    // Acknowledge immediately — the hub's own notifyWebhook() already has a
    // short timeout and never retries (see its own header), so there's no
    // reason to make it wait on our sync+reload finishing.
    res.status(202).end();

    for (const { datasetKey } of payload.datasets ?? []) {
      const handler = datasetHandlers[datasetKey];
      if (!handler) continue; // a notification for a dataset this app doesn't track — not an error
      try {
        const result = await syncOne(datasetKey, handler.relativePath, etagCache);
        if (result.status === 'updated') {
          log(`[watershed-live-sync] webhook-triggered sync: ${datasetKey} updated`);
          handler.onSynced?.();
        }
      } catch (err) {
        log(`[watershed-live-sync] webhook-triggered sync failed for ${datasetKey}: ${err.message}`);
      }
    }
  });

  return router;
}

module.exports = { startLiveSync, hubWebhookRouter, verifySignature, FAST_POLL_MS };
