// ═══════════════════════════════════════════════════════════════════════════
// hub-alert.js
// ═══════════════════════════════════════════════════════════════════════════
//
// NYT (bruger-krav 2026-09-16): watershed-hub's egen upålidelighed blev
// hidtil kun logget (console.warn) ved hver af de tre eksisterende hub-sync-
// fallback-stier (warmCacheFromHub/dmi-rain/CMEMS, se hver af deres egne
// catch-blokke) — ingen så det, medmindre nogen tilfældigt kiggede i `fly
// logs`. Denne fil er den fælles "sig fra" mekanisme alle tre nu kalder ind
// i, samme port til ukwater/frwater (hub-alert.js der, hubAlert.js her —
// samme navnekonvention-forskel som current-grid.js/currentGrid.js).
//
// To alvorlighedsgrader, bruger-defineret:
//  - hardDown (kaldet med hardDown=true): selve hub-forbindelsen fejlede
//    (kastet exception — netværksfejl, DNS, timeout). Varsler ØJEBLIKKELIGT
//    — ingen grund til at vente, en kastet exception er allerede en
//    definitiv fejl, ikke en midlertidig svingning.
//  - degraded (hardDown=false): hub'en SVAREDE, men leverede ikke friske
//    data for denne kilde (result.status 'error'/'not-yet-fetched-by-hub').
//    Varsler først efter DEGRADED_THRESHOLD_MS (15 min) sammenhængende —
//    ét enkelt udeladt cyklus skal ikke udløse en mail.
//
// Gentagelse: ét varsel ved første udløsning, derefter højst ét pr.
// REPEAT_INTERVAL_MS (30 min) mens tilstanden varer ved — hverken total
// stilhed under en lang nedetid, ej heller en mail-storm pr. cyklus.
'use strict';

const nodemailer = require('nodemailer');

const ALERT_EMAIL_ADDRESS = process.env.ALERT_EMAIL_ADDRESS || null;
const ALERT_EMAIL_APP_PASSWORD = process.env.ALERT_EMAIL_APP_PASSWORD || null;
const APP_LABEL = process.env.FLY_APP_NAME || 'dkvand';

const DEGRADED_THRESHOLD_MS = 15 * 60 * 1000;
const REPEAT_INTERVAL_MS = 30 * 60 * 1000;

let _transporter = null;
function getTransporter() {
  if (!ALERT_EMAIL_ADDRESS || !ALERT_EMAIL_APP_PASSWORD) return null;
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: ALERT_EMAIL_ADDRESS, pass: ALERT_EMAIL_APP_PASSWORD },
    });
  }
  return _transporter;
}

async function sendAlertEmail(subject, text) {
  const transporter = getTransporter();
  if (!transporter) {
    console.warn('[hub-alert] ALERT_EMAIL_ADDRESS/ALERT_EMAIL_APP_PASSWORD not set — skipping email:', subject);
    return;
  }
  try {
    await transporter.sendMail({
      from: ALERT_EMAIL_ADDRESS,
      to: ALERT_EMAIL_ADDRESS,
      subject: `[${APP_LABEL}] ${subject}`,
      text,
    });
  } catch (err) {
    // Never let an alert-email failure itself throw into a caller's own
    // hub-sync fallback path — that path already has real work to do
    // (falling back to a direct fetch) regardless of whether this succeeds.
    console.error('[hub-alert] failed to send alert email:', err.message);
  }
}

// sourceName -> { downSince, lastAlertSentAt, alerted }
const sourceState = new Map();

/**
 * Called from a hub-sync fallback branch — i.e. every time this app fell
 * back to a direct fetch (or is about to) because the hub sync didn't
 * deliver. See this file's own header for the hardDown/degraded distinction.
 * @param {string} sourceName - short, stable id, e.g. 'open-meteo-weather', 'dmi-rain', 'cmems-currents'
 * @param {string} reason - the underlying error/status, for the email body
 * @param {boolean} hardDown - true for a thrown/connection-level failure, false for a soft "hub responded but no fresh data" signal
 */
function reportHubFallback(sourceName, reason, hardDown = false) {
  const now = Date.now();
  let state = sourceState.get(sourceName);
  if (!state) {
    state = { downSince: now, lastAlertSentAt: 0, alerted: false };
    sourceState.set(sourceName, state);
  }
  const degradedForMs = now - state.downSince;
  const shouldFireFirst = !state.alerted && (hardDown || degradedForMs >= DEGRADED_THRESHOLD_MS);
  const shouldRepeat = state.alerted && (now - state.lastAlertSentAt >= REPEAT_INTERVAL_MS);
  if (!shouldFireFirst && !shouldRepeat) return;

  state.alerted = true;
  state.lastAlertSentAt = now;
  const minutesDown = Math.max(1, Math.round(degradedForMs / 60000));
  sendAlertEmail(
    `${hardDown ? 'Hub unreachable' : 'Hub degraded'} — ${sourceName}`,
    `${sourceName} has been ${hardDown ? 'unreachable' : 'degraded (reachable but not delivering fresh data)'} for ~${minutesDown} min.\n\n` +
    `Latest reason: ${reason}\n\n` +
    `${APP_LABEL} is running on its own direct-fetch fallback in the meantime — no data gap, but the hub itself needs attention.`
  );
}

/**
 * Called from the SAME fallback branch whenever a hub sync actually
 * succeeds — clears the down state, and if an alert was ever sent for this
 * incident, sends one final "it's back" email so you don't have to go check.
 * A no-op if this source was never marked down (the common case, every
 * cycle) — do not call this unconditionally on every success without
 * checking, it would be a silent no-op anyway, but callers should still
 * only call it on genuine success (result.status 'updated'/'unchanged').
 */
function reportHubRecovered(sourceName) {
  const state = sourceState.get(sourceName);
  if (!state) return;
  const wasAlerted = state.alerted;
  const downForMs = Date.now() - state.downSince;
  sourceState.delete(sourceName);
  if (wasAlerted) {
    const minutesDown = Math.max(1, Math.round(downForMs / 60000));
    sendAlertEmail(`Recovered — ${sourceName}`, `${sourceName}'s hub sync recovered after ~${minutesDown} min down/degraded.`);
  }
}

module.exports = { reportHubFallback, reportHubRecovered };
