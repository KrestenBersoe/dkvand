// ═══════════════════════════════════════════════════════════════════════════
// diagnose-dkcoast217-direkte.js — kør fra repo-roden
// ═══════════════════════════════════════════════════════════════════════════
// Kalder den ÆGTE computeBadevandRiskCascade() fra badevand-risk.js — ingen
// reimplementering — med UAS03R's BEKRÆFTEDE rigtige score fra
// /api/risk-scores (riskScore=0, viralScore=0, algaeScore=0.001372640684534102,
// foreRisk=0). Mod jeres rigtige geometrifiler. Hvis DKCOAST217 stadig
// mangler data her, er fejlen 100% i selve badevand-risk.js, ikke i nogen
// diagnostik-reimplementering.
'use strict';
const path = require('path');
const { computeBadevandRiskCascade } = require('./badevand-risk.js');
const riskModel = require('./risk-model');
const fs = require('fs');

const rawPuls = JSON.parse(fs.readFileSync('puls-data.json', 'utf8'));
const areas = rawPuls.w || [];
const auths = rawPuls.a || [];
const rows = rawPuls.d || rawPuls;

// Bygger ALLE 21.556 punkter, men sætter KUN UAS03R's score til den
// bekræftede rigtige værdi — resten får null (irrelevant for dette tjek,
// men holder listen fuldstændig så alle andre polygoner stadig kan matches
// normalt, i tilfælde af at det påvirker noget delt state).
const points = rows.map((r, i) => {
  const derived = riskModel.derivePulsFields(r);
  const areaIdx = r[4], authIdx = r[3];
  const isUAS03R = derived.name === 'UAS03R';
  return {
    id: i, name: derived.name || `Udløb ${i}`,
    municipality: auths[authIdx] || '—', waterArea: areas[areaIdx] || 'Ukendt',
    lat: derived.lat, lng: derived.lng,
    riskScore: isUAS03R ? 0 : null,
    viralScore: isUAS03R ? 0 : null,
    algaeScore: isUAS03R ? 0.001372640684534102 : null,
    foreRisk: isUAS03R ? 0 : null,
  };
});

const uas = points.find(p => p.name === 'UAS03R');
console.log('UAS03R i det byggede points-array:', JSON.stringify(uas));
console.log('');

computeBadevandRiskCascade(points, () => 2, () => 3, __dirname).then(result => {
  console.log('DKCOAST217 i resultatet:', JSON.stringify(result.kystvande['DKCOAST217'], null, 2));
  if (!result.kystvande['DKCOAST217']) {
    console.log('\n⚠ BEKRÆFTET: DKCOAST217 mangler STADIG, selv med den ægte funktion og en bekræftet, gyldig score. Fejlen er 100% i badevand-risk.js.');
  } else {
    console.log('\n✓ DKCOAST217 FIK data her — fejlen findes ikke i selve funktionen isoleret, må afhænge af noget i den fulde, levende dataramme (fx et andet punkt der overskriver/interfererer).');
  }
}).catch(e => {
  console.log('FEJL under kørsel:', e.message);
  console.log(e.stack);
});
