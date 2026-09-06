#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// validate-badevand-model-worker.js — én OS-tråd (worker_threads) i
// scripts/validate-badevand-model.js's backtest, se dens filhoved for den
// fulde begrundelse.
// ═══════════════════════════════════════════════════════════════════════════
//
// HVORFOR TRÅDE (bruger-krav — "previous code only ran a single thread
// taking 14 hours"): scripts/validate-predictions-historical.js kørte
// hele backtesten sekventielt på hovedtråden. To uafhængige kilder til
// spildtid identificeret ved læsning af badevand-risk.js:
//
//   1. computeBadevandRiskCascade() genindlæste OG genopbyggede ~10-15 MB
//      statiske geometrifiler (og deres afledte O(5.227)-segmentindeks)
//      FRA BUNDEN ved HVERT ENESTE kald — se badevand-risk.js's
//      loadStaticCascadeData()-kommentar. Denne worker indlæser den
//      bundtet ÉN GANG pr. tråd (loadStaticCascadeData, se nedenfor) og
//      genbruger den for samtlige datoer, den selv er ansvarlig for.
//   2. Selve O(udløb × geometrier)-matchingen i cascaden koster i sig selv
//      45-57 sek. PR. KALD, målt live (se badevand-risk-worker.js's
//      filhoved) — reelt CPU-arbejde, ikke I/O, og derfor noget der
//      RENT FAKTISK skalerer med antal CPU-kerner, hvis fordelt på flere
//      OS-tråde. Denne fils eneste formål er præcis dét: hver tråd kører
//      sin egen delmængde af de historiske datoer, fuldstændig uafhængigt
//      af de andre (ingen delt tilstand ml. tråde — hver dato er en
//      selvstændig cascade-genberegning givet den allerede hentede
//      nedbørs-/strømhistorik).
//
// Datavolumen: hverken nedbørsarkivet (cellSeriesEntries) eller
// strøm-historikken (currentSeriesEntries) refetches her — begge hentes
// ÉN GANG af hovedtråden (scripts/validate-badevand-model.js) og sendes
// med via workerData (strukturkloning — hver tråd får sin egen kopi i
// hukommelsen, men ingen ekstra netværkskald).
'use strict';

const { parentPort, workerData } = require('worker_threads');
const riskModel = require('../risk-model');
const badevandRisk = require('../badevand-risk');
const {
  sampleFailed, sampleExceedanceRatio, hourlySeriesEndingAt, rawRainSumWindow,
  seasonalTauForMonth, seasonalTauViralForMonth, isBathingSeasonMonth,
} = require('./lib/badevand-backtest-utils');

const HOURLY_WEEK_HOURS = 7 * 24;
const BASELINE_WINDOW_HOURS = 48; // se filhoved for scripts/validate-badevand-model.js's baseline-model

(async () => {
  try {
    const {
      staticDir, outlets, cellSeriesEntries, currentSeriesEntries,
      dateShard, // [{ dateIso, samples: [...] }]
    } = workerData;

    const cellSeriesByKey = new Map(cellSeriesEntries);
    const currentSeriesByKey = new Map(currentSeriesEntries.map(([k, arr]) => [k, new Map(arr)]));
    const getCurrentAtForDate = (dateIso) => (lat, lng) => {
      const key = riskModel.cellKey(lat, lng);
      return currentSeriesByKey.get(key)?.get(dateIso) ?? null;
    };

    // NYT: statisk geometribundt indlæst ÉN GANG for HELE denne trådens
    // levetid — genbrugt for hver eneste dato nedenfor, se filhoved.
    const staticCache = badevandRisk.loadStaticCascadeData(staticDir);

    // Beregner den fulde cascade for ÉN dato, givet allerede hentet
    // nedbørs-/strømhistorik. Returnerer { bactBySite: Map<siteId, {bact,
    // waterType, dataConfidence, dominantOutletCellKey}> } — kun det, den
    // efterfølgende lag-sammenligning rent faktisk skal bruge.
    async function scoreDate(dateIso) {
      const month = new Date(`${dateIso}T12:00:00Z`).getUTCMonth();
      const tau = seasonalTauForMonth(riskModel, month);
      const tauV = seasonalTauViralForMonth(riskModel, month);

      const points = outlets.map((o) => {
        const series = cellSeriesByKey.get(riskModel.cellKey(o.lat, o.lng));
        if (!series) return { ...o, riskScore: null, viralScore: null, foreRisk: null };
        const hourlyWeek = hourlySeriesEndingAt(series, dateIso, HOURLY_WEEK_HOURS);
        const decayedSeries = riskModel.accumulateDecayed(hourlyWeek, 3.0);
        const antecedentMM = decayedSeries.length ? decayedSeries[decayedSeries.length - 1] : 0;
        const lastEventAge = riskModel.estimateLastEventAge(hourlyWeek, o.thresholdMm);
        const { risk } = riskModel.computeRisk({
          overflowProbBase: o.overflowProbBase, meanVolumePerEvent: o.meanVolumePerEvent,
          thresholdMm: o.thresholdMm, precipMM: antecedentMM, lastEventAge,
        });
        return { ...o, riskScore: risk, viralScore: null, foreRisk: null };
      });

      const result = await badevandRisk.computeBadevandRiskCascade(
        points, () => tau, () => tauV, staticDir, 200, getCurrentAtForDate(dateIso), staticCache,
      );
      const bySite = new Map((result.badevand || []).map((b) => [b.id, b]));
      return bySite;
    }

    // Rå (ikke-henfaldet) 48-timers nedbørssum for et badesteds DOMINERENDE
    // udløb (samme "outlets[0], allerede sorteret efter faktisk bidrag"-
    // konvention badevand-risk.js selv bruger, se validate-predictions-
    // historical.js's tilsvarende brug) — den trivielle baseline-models
    // "score", helt uafhængig af per-udløbs-tærskler/henfald.
    function baselineRawMm(siteResult, dateIso) {
      const dominant = (siteResult?.outlets || [])[0];
      if (!dominant || dominant.lat == null || dominant.lng == null) return null;
      const series = cellSeriesByKey.get(riskModel.cellKey(dominant.lat, dominant.lng));
      if (!series) return null;
      return rawRainSumWindow(series, dateIso, BASELINE_WINDOW_HOURS);
    }

    function isoMinusDays(dateIso, days) {
      const ms = new Date(`${dateIso}T12:00:00Z`).getTime() - days * 86400000;
      return new Date(ms).toISOString().slice(0, 10);
    }

    // Memoiseret pr. dato (ikke kun pr. sample) — to nabo-datoer i samme
    // trådskår (fx to på hinanden følgende prøvedatoer) ville ellers hver
    // udløse deres EGEN cascade-genberegning af den fælles mellemliggende
    // dag (D+1's "i går" == D's "i dag"), dobbelt arbejde for ingenting.
    const scoreDateCache = new Map();
    function scoreDateCached(dateIso) {
      if (!scoreDateCache.has(dateIso)) scoreDateCache.set(dateIso, scoreDate(dateIso));
      return scoreDateCache.get(dateIso);
    }

    const records = [];
    let processed = 0;
    for (const { dateIso, samples } of dateShard) {
      const dateMinus1 = isoMinusDays(dateIso, 1);
      let bySiteToday, bySiteYesterday;
      try {
        bySiteToday = await scoreDateCached(dateIso);
        bySiteYesterday = await scoreDateCached(dateMinus1);
      } catch (err) {
        parentPort.postMessage({ type: 'warn', message: `cascade fejlede for ${dateIso}: ${err.message}` });
        processed++;
        continue;
      }

      const month = new Date(`${dateIso}T12:00:00Z`).getUTCMonth();
      for (const sample of samples) {
        const failed = sampleFailed(sample);
        if (failed === null) continue; // intet lab-facit at sammenligne mod

        const todaySite = bySiteToday.get(sample.siteId);
        const yestSite = bySiteYesterday.get(sample.siteId);
        const bactToday = todaySite?.bact ?? null;
        const bactYesterday = yestSite?.bact ?? null;
        const bactMax48h = (bactToday == null && bactYesterday == null) ? null
          : Math.max(bactToday ?? -Infinity, bactYesterday ?? -Infinity);

        const baselineToday = baselineRawMm(todaySite, dateIso);
        const baselineYesterday = baselineRawMm(yestSite, dateMinus1);
        const baselineMax48h = (baselineToday == null && baselineYesterday == null) ? null
          : Math.max(baselineToday ?? -Infinity, baselineYesterday ?? -Infinity);

        const common = {
          siteId: sample.siteId, dateIso, failed,
          exceedanceRatio: sampleExceedanceRatio(sample),
          waterType: todaySite?.waterType ?? yestSite?.waterType ?? null,
          dataConfidence: todaySite?.dataConfidence ?? yestSite?.dataConfidence ?? null,
          month, bathingSeason: isBathingSeasonMonth(month),
        };
        records.push({ ...common, lag: 'sameDay', bact: bactToday, baselineMm: baselineToday });
        records.push({ ...common, lag: 'tMinus1', bact: bactYesterday, baselineMm: baselineYesterday });
        records.push({ ...common, lag: 'max48h', bact: bactMax48h === -Infinity ? null : bactMax48h, baselineMm: baselineMax48h === -Infinity ? null : baselineMax48h });
      }

      processed++;
      parentPort.postMessage({ type: 'progress', processed, total: dateShard.length });
    }

    parentPort.postMessage({ type: 'done', records });
  } catch (err) {
    parentPort.postMessage({ type: 'fatal', error: err.message, stack: err.stack });
  }
})();
