// ═══════════════════════════════════════════════════════════════════════════
// risk-model.js
// ═══════════════════════════════════════════════════════════════════════════
//
// Server-side PORT af den bakterielle risikomodel fra dansk-overloeb-kort.html
// (computeRisk, computeForecastRisk, seasonalTau, cellKey — se de respektive
// funktioner i frontend-filen for den oprindelige, autoritative version).
//
// HVORFOR DENNE FIL FINDES: web push-notifikationer kunne tidligere KUN
// udløses, hvis en browserfane var åben og selv opdagede risikoen (se
// evaluatePushNotifications() i server.js) — hvilket modsiger selve formålet
// med push (at blive advaret UDEN at have appen åben). Løsningen er at lade
// SERVEREN selv evaluere risikoen periodisk, uafhængigt af klienter — hvilket
// kræver at risikoformlen findes ét sted, serveren kan køre den, ikke kun i
// browser-JavaScript.
//
// VIGTIGT — HOLD DENNE FIL I SYNC MED FRONTEND'EN: hvis risikoformlen
// (computeRisk/computeForecastRisk/seasonalTau) ændres i dansk-overloeb-
// kort.html, SKAL den samme ændring foretages her, ellers vil push-
// notifikationer (server) og selve kortets visning (klient) stille og
// roligt komme til at afvige fra hinanden — brugeren kunne fx modtage et
// push-varsel for en risiko, kortet ikke viser, eller omvendt.
//
// KENDT, BEVIDST BEVARET EGENSKAB (ikke indført her, allerede sådan i
// frontend'en): `lastEventAge` (tid siden sidste overløbshændelse, bruges
// til "residual"-forureningstillægget) er IKKE baseret på reelle historiske
// hændelsestidspunkter — den sættes til et TILFÆLDIGT tal (Math.random()*2
// dage) når nedbøren overstiger 5 mm. Denne port bevarer adfærden UÆNDRET
// for at undgå at push-notifikationer og kortets visning afviger fra
// hinanden — men det er værd at kende, hvis den tilfældige komponent
// nogensinde skal erstattes af rigtige data.
'use strict';

// ── Konstanter (identiske med dansk-overloeb-kort.html) ─────────────────────
const TAU_BASE_DAYS      = 1.0;  // reference τ ved 20°C + fuldt sommerlys
const Q10                = 2.0;  // temperatur-følsomhedskoefficient
const SEDIMENT_REBOUND   = 0.20;
const DK_RAINY_DAYS_YEAR = 73;
const DK_WATER_TEMP      = [2, 2, 4, 8, 12, 16, 18, 17, 14, 10, 6, 3];
const DK_DAYLIGHT_HRS    = [7.5, 9.5, 12, 14.5, 17, 18, 17.5, 15.5, 13, 10.5, 8, 7];
const GRID_DEG           = 0.25; // skal matche gridKey()/cellKey() i server.js hhv. frontend

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

// ── computeIntensityFactor — fælles for computeRisk() og computeViralRisk() ─
// Tidligere to parallelle, matematisk identiske kopier (samme risiko for
// stille afdrift som accumulateDecayed() nedenfor havde). thresholdMm er den
// udløbs-specifikke empiriske nedbørstærskel fra
// scripts/compute-puls-udloeb-taerskler.js (se puls-udloeb-taerskler.json,
// flettet ind i puls-data.json's row[13] af scripts/merge-puls-thresholds.js)
// — null/undefined for de ~39% af udløb uden en tilstrækkeligt sikker
// tærskel, hvilket her giver threshold=25/scale=5.
//
// RETTET (2026-07-30): fallback hævet fra 5mm til 25mm — 5mm var et
// domæneskøn, ikke empirisk funderet (se badevand-risk.js' filhoved).
// scripts/calibrate-overflow-model.js' kørsel samme dato bekræftede
// uafhængigt via to metoder at reelle tærskler ligger markant højere: (a)
// de allerede deployede per-udløbs-tærskler (puls-udloeb-taerskler.json,
// gruppe 1, n=2.601) har median 27mm, IQR 17-32mm; (b) en pooled ja/nej-
// overløbsklassifikator for fælleskloak-udløb (n=781 test) landede på en
// effektiv beslutningsgrænse på 41,6mm (AUC 0,61, 95%-CI [0,57-0,65] —
// moderat, ikke stærkt signal). 25mm er valgt som den bedre funderede
// kilde (a)'s median — IKKE kilde (b)'s 41,6mm, som hviler på et svagere,
// pooled fit. Se overflow-model-calibration-report-2026-07-30.json for
// fuld begrundelse/forbehold. Multiplikatoren (×3 i computeRisk()/
// computeViralRisk() nedenfor) er BEVIDST ikke ændret her — samme
// kalibrering fandt at tærskel og multiplikator ikke er uafhængigt
// identificerbare fra denne type ja/nej-facit (se rapportens
// methodologyNote.identifiabilityNote); det kræver volumen-/
// koncentrationsdata, uden for scope for denne kørsel.
// HOLD I SYNC MED KLIENTEN: dansk-overloeb-kort.html's identiske
// computeIntensityFactor()-kopi SKAL opdateres samtidig med denne.
function computeIntensityFactor(precipMM, thresholdMm) {
  const threshold = (thresholdMm !== null && thresholdMm !== undefined) ? thresholdMm : 25;
  const scale      = threshold / 5;
  const ramp       = Math.min(Math.max(precipMM - scale * 1, 0) / (scale * 6), 1);
  return sigmoid((precipMM - threshold) / (scale * 4)) * ramp;
}

// Memoized pr. måned — samme begrundelse/ydelsesfix som i frontend'en (se
// dansk-overloeb-kort.html): uden memoization genberegnes Math.pow for
// hvert eneste PULS-punkt, selvom værdien er identisk for alle.
let _seasonalTauCache = null;
function seasonalTau() {
  const month = new Date().getMonth();
  if (_seasonalTauCache && _seasonalTauCache.month === month) return _seasonalTauCache.value;
  const T     = DK_WATER_TEMP[month];
  const light = DK_DAYLIGHT_HRS[month];
  const tempFactor  = Math.pow(Q10, (20 - T) / 10);
  const lightFactor = 12 / Math.max(light, 4);
  const value = TAU_BASE_DAYS * tempFactor * lightFactor;
  _seasonalTauCache = { month, value };
  return value;
}

// ── cellKey / gridKey — 0,25° gitter, celle-CENTRUM, 4 decimaler ───────────
// Identisk algoritme til klientens cellKey() og server.js' eksisterende
// gridKey() — SKAL forblive identisk, ellers matcher opslag i weatherCache
// aldrig de rigtige celler.
function cellKey(lat, lng) {
  const clat = Math.round((Math.floor(lat / GRID_DEG) * GRID_DEG + GRID_DEG / 2) * 10000) / 10000;
  const clng = Math.round((Math.floor(lng / GRID_DEG) * GRID_DEG + GRID_DEG / 2) * 10000) / 10000;
  return `${clat.toFixed(4)}:${clng.toFixed(4)}`;
}

// ── computeRisk — identisk port af frontend-funktionen ──────────────────────
function computeRisk(pt) {
  const { overflowProbBase, meanVolumePerEvent, precipMM, lastEventAge } = pt;

  if (precipMM === null || precipMM === undefined) {
    return { pOverflow: null, severity: null, risk: null, tau: seasonalTau(), noData: true };
  }

  const intensityFactor = computeIntensityFactor(precipMM, pt.thresholdMm);

  const pOverflow = Math.min(overflowProbBase * intensityFactor * 3, 1);
  const severity  = Math.min(Math.log10(meanVolumePerEvent + 1) / 5, 1);
  let   risk      = pOverflow * (0.6 + 0.4 * severity);

  if (lastEventAge !== null && lastEventAge !== undefined && lastEventAge >= 0) {
    const tau       = seasonalTau();
    const amplitude = 0.9 * (1 + SEDIMENT_REBOUND);
    const residual  = amplitude * Math.exp(-lastEventAge / tau);
    risk = Math.min(risk + residual * (1 - risk), 1);
  }

  return { pOverflow, severity, risk, tau: seasonalTau(), noData: false };
}

// ── computeForecastRisk — identisk port ─────────────────────────────────────
function computeForecastRisk(pt) {
  if (pt.precipMM === null || pt.precipMM === undefined) return null;
  const tmpPt = { ...pt, precipMM: (pt.precipMM || 0) + (pt.forecastMM || 0) };
  return computeRisk(tmpPt).risk;
}

// ── Viral risikomodel — identisk port af computeViralRisk i frontend'en ────
// NYT: nødvendig for at badested-varsler kan matche panelets "Samlet
// forureningsrisiko" (max af bakteriel+viral+alge), ikke kun bakteriel
// risiko for enkelte udløb — se diskussion i samtalen om badested-varslers
// samlede score. Algerisiko er BEVIDST UDELADT her (ikke en forglemmelse):
// den afhænger af CMEMS-strømdata og vandområde-polygonmaskering, som kun
// findes klient-side i dag — at portere det er en større, separat opgave.
const VIRAL_AMPLITUDE_BASE = 0.5;
const VIRAL_SEVERITY_WEIGHT = 0.3;
const VIRAL_RESIDUAL_AMPLITUDE = 0.75;
const TAU_VIRAL_BASE = 2.0;
const Q10_VIRAL = 4.0;

let _seasonalTauViralCache = null;
function seasonalTauViral() {
  const month = new Date().getMonth();
  if (_seasonalTauViralCache && _seasonalTauViralCache.month === month) return _seasonalTauViralCache.value;
  const T     = DK_WATER_TEMP[month];
  const light = DK_DAYLIGHT_HRS[month];
  const tempFactor  = Math.pow(Q10_VIRAL, (20 - T) / 10);
  const lightFactor = T >= 12 ? (12 / Math.max(light, 4)) : 1.0;
  const value = TAU_VIRAL_BASE * tempFactor * lightFactor;
  _seasonalTauViralCache = { month, value };
  return value;
}

function computeViralRisk(pt) {
  const { overflowProbBase, meanVolumePerEvent, precipMM, lastEventAge } = pt;
  if (precipMM === null || precipMM === undefined) return null;

  const intensityFactor = computeIntensityFactor(precipMM, pt.thresholdMm);
  const pOverflow       = Math.min(overflowProbBase * intensityFactor * 3, 1);
  const severity        = Math.min(Math.log10(meanVolumePerEvent + 1) / 5, 1);

  let viralRisk = pOverflow * (VIRAL_AMPLITUDE_BASE + VIRAL_SEVERITY_WEIGHT * severity);

  if (lastEventAge !== null && lastEventAge !== undefined && lastEventAge >= 0) {
    const tauV      = seasonalTauViral();
    const residualV = VIRAL_RESIDUAL_AMPLITUDE * Math.exp(-lastEventAge / tauV);
    viralRisk = Math.min(viralRisk + residualV * (1 - viralRisk), 1);
  }
  return viralRisk;
}

function computeForecastViralRisk(pt) {
  if (pt.precipMM === null || pt.precipMM === undefined) return null;
  const tmpPt = { ...pt, precipMM: (pt.precipMM || 0) + (pt.forecastMM || 0) };
  return computeViralRisk(tmpPt);
}

// ── Afledte PULS-felter — identisk port af loadFromEmbedded()'s beregning ──
// Row: [lat, lng, name, authIdx, areaIdx, volumeM3, eventsPerYear|null,
//       qualityCode, outfallId, reducedArea, type, sewerStructure,
//       latestDischargeYear, thresholdMm|null]
// thresholdMm(13) — udløbs-specifik empirisk nedbørstærskel, flettet ind af
// scripts/merge-puls-thresholds.js; null for udløb uden en tilstrækkeligt
// sikker tærskel (se computeIntensityFactor() ovenfor for fallback-adfærd).
//
// NYT (bruger-ønske 2026-07-25): sewerStructure(11) — samme nationale
// kodesystem som klientens RBU_WASTEWATER_TYPES/RBU_NO_WASTEWATER_TYPES (se
// dansk-overloeb-kort.html), her anvendt på PULS-udløbets EGEN kode i
// stedet for RBU-lagets bgv_type. isWastewater er false KUN for bekræftede
// rene regnvandsudløb (SE/SF, "Separat regnvand") — "Andet"/uklassificeret
// (fx 'ikke oplyst', 'UR', 'Bypass') regnes bevidst MED som spildevand, for
// ikke at overse en reel kilde pga. mangelfuld registrering. Bruges af
// badevand-risk.js til at udelukke bekræftede regnvandsudløb fra
// bakteriel/viral-risikoen for badesteder/søer/kystvande — selve
// overløbs-sandsynligheden (det generelle overløbskort) er UPÅVIRKET af
// dette felt, den er lige relevant uanset udløbstype.
const PULS_NO_WASTEWATER_CODES = new Set(['SE', 'SF']);
function derivePulsFields(row) {
  const [lat, lng, name, authIdx, areaIdx, volumeM3, eventsPerYear] = row;
  const thresholdMm = row[13] ?? null;
  const sewerStructure = row[11] ?? null;
  const ev  = eventsPerYear !== null ? eventsPerYear : 0;
  const vol = volumeM3 > 0 ? volumeM3 : 0;
  return {
    lat, lng, name,
    meanVolumePerEvent: vol / Math.max(ev, 1),
    overflowProbBase:   Math.min(ev / DK_RAINY_DAYS_YEAR, 1),
    thresholdMm,
    isWastewater: !PULS_NO_WASTEWATER_CODES.has(sewerStructure),
  };
}

// ── estimateLastEventAge — ÆGTE databaseret erstatning for tidligere Math.random() ──
// TIDLIGERE (både i denne fil og i dansk-overloeb-kort.html): lastEventAge
// blev sat til Math.random()*2 dage, når nedbøren oversteg 5 mm — en ren
// tilfældig placeholder, ikke afledt af faktiske data.
//
// NU: rekonstruerer den henfaldsvægtede nedbørsakkumulering (samme τ=3
// dage og matematiske form som antecedentMM ovenfor, se computeMetrics() i
// server.js) for HVERT tidspunkt i den 7-dages historik, appen allerede
// henter (hourlyWeek — én værdi pr. time, kronologisk, ældste først).
// Finder derefter det SENESTE tidspunkt, hvor denne rekonstruerede
// akkumulering nåede samme tærskel (5 mm), som computeRisk()'s sigmoid
// selv bruger som "sandsynligt udløsningspunkt" for et overløb — og
// returnerer antal dage siden dét tidspunkt.
//
// Dette er stadig en AFLEDT tilnærmelse, ikke en bekræftet, målt
// overløbshændelse (PULS leverer kun årlige gennemsnitstal, ingen
// tidsstemplede enkelthændelser) — men det er nu baseret på faktisk
// observeret nedbør, ikke tilfældige tal.
const LAST_EVENT_TRIGGER_MM = 5;    // samme tærskel som computeRisk()'s intensityFactor-sigmoid er centreret om
const HOURLY_DECAY_TAU_DAYS = 3.0;  // skal matche TAU i server.js' computeMetrics()

// ── accumulateDecayed — DEN ene, fælles henfaldsakkumulering ────────────────
// Rullende eksponentielt henfald, time for time, over en kronologisk
// (ældste først) time-serie af nedbør (mm). Returnerer en lige så lang
// serie: den akkumulerede, henfaldede værdi PR. TIME, ikke kun sluttallet —
// nødvendig for at kunne finde peaks/tærskler hvor som helst i en historisk
// serie, ikke kun "værdien lige nu".
//
// Var tidligere to parallelle, matematisk ækvivalente udgaver: denne
// rullende form (oprindeligt kun i estimateLastEventAge, se nedenfor) og en
// alders-vægtet sum-form i server.js' computeMetrics() (antecedentMM).
// Konsolideret til ét sted, begge steder kalder nu denne. server.js henter
// derfor kun SLUTVÆRDIEN af serien (den nyeste time) til antecedentMM — en
// lille, accepteret præcisionsforskel: computeMetrics() vægtede tidligere
// efter den PRÆCISE alder i millisekunder (kunne være <1 time forskudt fra
// selve time-bucketen pga. Date.now()), denne udgave regner i hele
// timeskridt. Forskellen er <1,5 % af antecedentMM ved τ=3 dage.
function accumulateDecayed(hourlyMm, tauDays) {
  const hourlyDecayFactor = Math.exp(-1 / (24 * tauDays)); // henfald pr. TIME, ikke pr. dag
  let decayed = 0;
  const series = [];
  for (let i = 0; i < hourlyMm.length; i++) {
    decayed = decayed * hourlyDecayFactor + (hourlyMm[i] || 0);
    series.push(decayed);
  }
  return series;
}

function estimateLastEventAge(hourlyWeek) {
  if (!Array.isArray(hourlyWeek) || hourlyWeek.length === 0) return null;

  const series = accumulateDecayed(hourlyWeek, HOURLY_DECAY_TAU_DAYS);

  // RETTET: den oprindelige udgave ledte efter den SENESTE time, hvor den
  // henfaldsvægtede akkumulering stadig var over tærsklen — men ved τ=3
  // dages langsomt henfald forbliver værdien forhøjet i mange timer EFTER
  // selve regnbygen (en 15 mm byge er stadig ~71% af sin styrke et helt
  // døgn senere), så det fandt reelt bare "nu" i stedet for hændelsens
  // starttidspunkt. Rettet til i stedet at finde den SENESTE OPADGÅENDE
  // tærskel-krydsning (fra under til over tærsklen) — det markerer hvornår
  // en ny, betydende regnhændelse rent faktisk STARTEDE.
  let wasBelowThreshold = true;
  let lastTriggerIndex = -1;
  for (let i = 0; i < series.length; i++) {
    const isAboveThreshold = series[i] >= LAST_EVENT_TRIGGER_MM;
    if (isAboveThreshold && wasBelowThreshold) lastTriggerIndex = i; // opadgående krydsning
    wasBelowThreshold = !isAboveThreshold;
  }

  if (lastTriggerIndex === -1) return null; // ingen opadgående krydsning i vinduet — intet kendt nyligt "udløsningspunkt"

  const hoursAgo = (hourlyWeek.length - 1) - lastTriggerIndex;
  return hoursAgo / 24; // omregnet til dage, samme enhed som lastEventAge altid har brugt
}

module.exports = {
  sigmoid, seasonalTau, seasonalTauViral, cellKey, computeRisk, computeForecastRisk,
  computeViralRisk, computeForecastViralRisk, derivePulsFields, estimateLastEventAge,
  accumulateDecayed, computeIntensityFactor,
  GRID_DEG, TAU_BASE_DAYS, Q10, SEDIMENT_REBOUND, DK_RAINY_DAYS_YEAR, DK_WATER_TEMP, DK_DAYLIGHT_HRS,
  LAST_EVENT_TRIGGER_MM, HOURLY_DECAY_TAU_DAYS, TAU_VIRAL_BASE, Q10_VIRAL,
};

// NYT: server-side port af computeFreshwaterTemp()/computeAlgaeRisk() fra
// dansk-overloeb-kort.html. RETTET (selv-fanget efter direkte
// tilbagemelding): var tidligere bevidst UDELADT server-side med
// begrundelsen "afhænger af CMEMS-strøm, ikke porteret server-side" — men
// den begrundelse var forkert, CMEMS-strømdata (inklusiv havtemperatur)
// har allerede været hentet og cachet server-side i lang tid (se
// currentsCache i server.js, opdateret hver time). Alt algemodellen
// reelt har brug for var allerede tilgængeligt server-side; det var kun
// selve BEREGNINGEN, der aldrig var blevet flyttet.
//
// waterTemp gives som PARAMETER, ikke beregnet her — selve CMEMS-
// opslaget/isWater-afgørelsen involverer datastrukturer (currentsCache.
// grid), der hører hjemme i server.js/badevand-risk.js, ikke i dette
// rene beregningsmodul. Samme adskillelse som computeRisk() allerede
// bruger (precipMM/forecastMM gives som input, hentes ikke selv).
function computeFreshwaterTemp(airTempAvg) {
  if (airTempAvg === null || airTempAvg === undefined) return null;
  const mu = 1, alpha = 24, beta = 9, gamma = 0.2;
  return mu + (alpha - mu) / (1 + Math.exp(gamma * (beta - airTempAvg)));
}

function computeAlgaeRisk({ totalRain7d, volumeM3Year, waterTemp }) {
  if (totalRain7d === null || totalRain7d === undefined) return null;
  if (waterTemp === null || waterTemp === undefined) return null;

  const nutrientProxy = Math.min((totalRain7d || 0) / 40, 1) *
    (0.5 + 0.5 * Math.min(Math.log10((volumeM3Year || 0) / 50 + 1) / 3, 1));
  const tempFactor = 1 / (1 + Math.exp(-(waterTemp - 18) / 2.5));
  return Math.min(nutrientProxy * tempFactor * 1.3, 1);
}

module.exports.computeFreshwaterTemp = computeFreshwaterTemp;
module.exports.computeAlgaeRisk = computeAlgaeRisk;
