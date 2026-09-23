// ═══════════════════════════════════════════════════════════════════════════
// private-site-risk.js — periodisk scoring af private badesteder
// ═══════════════════════════════════════════════════════════════════════════
//
// PORT af ukwater/frwaters server/risk/privateSiteService.js +
// runPrivateScoring.js (slået sammen til én fil her — dkvand er ikke opdelt
// i en server/-træstruktur som ukwater/frwater er). Se private-sites.js's
// filhoved for HVORFOR dette IKKE bare kan genbruge ukwaters egen
// scoreOneOff()-tilgang: dkvand's model (badevand-risk.js's
// computeBadevandRiskCascade()) er en reel sø-/kystvand-/vandløbs-kaskade,
// hvor selve udløbs-til-vandområde-opbygningen (45-57 sek., se
// badevand-risk-worker.js) er nødvendig UANSET hvor mange badevandspunkter
// der scores i samme kørsel — modsat ukwaters isotropiske
// afstands-fra-nærmeste-udløb-model, som kan scoreOneSite() billigt.
//
// Konsekvens: ÉT privat badesteds score koster her lige så meget som den
// FULDE officielle kaskade, uanset om det er en planlagt batch (nedenfor)
// eller et enkelt on-demand kald (scoreOneOff()). Kører derfor:
//   - på sin EGEN, adskilte worker_thread (deps.runCascade — server.js's
//     runBadevandRiskCascadeInWorker(), som spawner en HELT NY OS-tråd pr.
//     kald) — en byrde af private badesteder må ALDRIG konkurrere om den
//     trådplads den officielle 15-minutters-kaskade er afhængig af.
//   - kun for badesteder med mindst én aktiv push-abonnent (se
//     private-sites.js's getSubscribedPrivateSiteIds()) — det er det, der
//     reelt begrænser omkostningen efterhånden som det samlede antal
//     oprettede badesteder vokser; et privat badested uden abonnenter
//     indgår ALDRIG i denne cyklus, kun i scoreOneOff() ved faktisk
//     sidevisning.
//   - på 30 minutters kadence, ikke den officielle 15 — samme begrundelse
//     som ukwater: et enkelt privat badested har meget få interesserede,
//     intet tidskritisk tabes ved sjældnere genberegning.
'use strict';

const PRIVATE_RECOMPUTE_INTERVAL_MS = 30 * 60 * 1000;
const PRIVATE_SITE_STALE_MS = PRIVATE_RECOMPUTE_INTERVAL_MS;

/**
 * @param {object} deps
 * @param {() => Array<object>|null} deps.getScoredPulsPoints - seneste PULS-scorede punkter (server.js's riskScoresCache.points), eller null/tom hvis intet er beregnet endnu
 * @param {(points, staticDir, grid, adHocPoints) => Promise<{badevand: object[]}>} deps.runCascade - server.js's runBadevandRiskCascadeInWorker()
 * @param {string} deps.staticDir
 * @param {() => any} deps.getCurrentGrid - () => currentsCache.grid
 * @param {import('./private-sites')} deps.privateSites
 */
function createPrivateSiteRiskService(deps) {
  const { getScoredPulsPoints, runCascade, staticDir, getCurrentGrid, privateSites } = deps;
  const latest = new Map(); // siteId -> { ...badevand-risk.js's badevand-post, scoredAtMs }
  let recomputing = false;
  const inFlightOneOff = new Map(); // siteId -> Promise — se scoreOneOff()'s filhoved

  async function scoreSites(sites) {
    const points = getScoredPulsPoints();
    if (!points || points.length === 0) {
      console.warn('[private-site-risk] ingen scorede PULS-punkter tilgængelige endnu — springer over');
      return [];
    }
    const adHocPoints = sites.map(s => ({ siteId: s.siteId, lat: s.lat, lng: s.lng }));
    const result = await runCascade(points, staticDir, getCurrentGrid(), adHocPoints);
    const scoredAtMs = Date.now();
    const bySiteId = new Map((result.badevand || []).map(b => [String(b.id), b]));
    const scored = [];
    for (const site of sites) {
      const row = bySiteId.get(site.siteId);
      if (!row) continue;
      const entry = { ...row, scoredAtMs };
      latest.set(site.siteId, entry);
      scored.push(entry);
    }
    return scored;
  }

  async function recompute() {
    if (recomputing) return;
    recomputing = true;
    try {
      const subscribedSiteIds = await privateSites.getSubscribedPrivateSiteIds();
      if (subscribedSiteIds.length === 0) return; // intet at gøre denne cyklus — selve pointen med abonnent-gaten

      const sites = await privateSites.getActivePrivateSitesByIds(subscribedSiteIds); // udelukker tilbagekaldte
      if (sites.length === 0) return;

      await scoreSites(sites);
      console.log(`[private-site-risk] genberegnede ${sites.length} abonneret(e) private badested(er)`);
    } catch (err) {
      console.error('[private-site-risk] recompute fejlede:', err.message);
    } finally {
      recomputing = false;
    }
  }

  /**
   * On-demand enkelt-badested-scoring — brugt af GET /api/private-sites/:id
   * når intet cachet resultat findes eller det er ældre end
   * PRIVATE_SITE_STALE_MS, så et nyoprettet eller sjældent besøgt privat
   * badesteds FØRSTE visning ikke sidder fast og venter på næste planlagte
   * cyklus. IKKE afventet af selve HTTP-svaret (se server.js's routehandler
   * — filhovedets ~50-sekunders-omkostning gør et synkront HTTP-svar
   * upassende, samme princip som ensureFreshRiskCaches() allerede undgår
   * for den officielle kaskade).
   *
   * inFlightOneOff dedupliker KUN samtidige kald for SAMME siteId (fx
   * dobbeltklik, flere åbne faner) — to FORSKELLIGE badesteders on-demand
   * kald kan i sjældne tilfælde stadig overlappe som to separate worker-
   * kørsler; accepteret, samme afvejning ukwaters egen service.js gør
   * eksplicit for sine to legitime samtidige kaldere.
   * @param {{siteId: string, lat: number, lng: number}} site
   */
  function scoreOneOff(site) {
    const existing = inFlightOneOff.get(site.siteId);
    if (existing) return existing;
    const p = scoreSites([site])
      .then(([result]) => result ?? null)
      .finally(() => inFlightOneOff.delete(site.siteId));
    inFlightOneOff.set(site.siteId, p);
    return p;
  }

  function getLatest(siteId) {
    return latest.get(siteId) || null;
  }

  recompute();
  const timer = setInterval(recompute, PRIVATE_RECOMPUTE_INTERVAL_MS);
  timer.unref();

  return { getLatest, scoreOneOff, recomputeNow: recompute, stop: () => clearInterval(timer) };
}

module.exports = { createPrivateSiteRiskService, PRIVATE_RECOMPUTE_INTERVAL_MS, PRIVATE_SITE_STALE_MS };
