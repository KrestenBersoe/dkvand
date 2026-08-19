// ═══════════════════════════════════════════════════════════════════════════
// overloeb-events.js
// ═══════════════════════════════════════════════════════════════════════════
//
// Kommune Dashboard, "Overløb"-fanen (bruger-ønske 2026-08-19, opfølgning:
// "gemmer vi varsler pr. udløb med timestamp") — hændelsesbaseret log af
// hvert PULS-punkts grøn/gul/rød-TILSTANDSSKIFT, med tidsstempel.
//
// BEVIDST VALGT MODEL (af tre diskuterede, se samtalen): kun ved skift, IKKE
// et snapshot af alle ~21.600 punkter hvert 15. minut — det sidste ville
// give ~757 mio. rækker/år (~60-70 GB), mens denne model realistisk lander
// på ~0,2-1 mio. rækker/år (~10-50 MB/år). Ingen beskæring nødvendig, samme
// "lille nok til aldrig at vokse sig et problem"-klasse som app-metrics.js's
// push_send_totals.
//
// Kun "nu"-risikoen logges (se server.js's kaldested i
// _evaluatePushNotificationsInner()) — ALDRIG 24h/72h-prognosehorisonterne,
// som skifter konstant uden at noget reelt er indtruffet.

const { query } = require('./db');

const ready = query(`
  CREATE TABLE IF NOT EXISTS overloeb_status_events (
    id               SERIAL PRIMARY KEY,
    point_id         TEXT NOT NULL,
    municipality_key TEXT NOT NULL,
    bucket           TEXT NOT NULL,
    prev_bucket      TEXT NOT NULL,
    risk             DOUBLE PRECISION,
    created_at       BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_overloeb_events_muni_time  ON overloeb_status_events(municipality_key, created_at);
  CREATE INDEX IF NOT EXISTS idx_overloeb_events_point_time ON overloeb_status_events(point_id, created_at);
`).then(() => console.info('overloeb-events: Postgres-skema klar'))
  .catch(e => { console.error('overloeb-events: skemaoprettelse fejlede —', e.message); throw e; });

// NYT: bulk-INSERT — kaldes højst én gang pr. 15-minutters-cyklus med ALLE
// dette cyklus' transitions samlet, ikke én forespørgsel pr. punkt.
async function recordTransitions(events) {
  if (!Array.isArray(events) || events.length === 0) return;
  const values = [];
  const rows = events.map((e, i) => {
    const base = i * 6;
    values.push(e.pointId, e.municipalityKey, e.bucket, e.prevBucket, e.risk ?? null, e.createdAt);
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
  });
  await query(
    `INSERT INTO overloeb_status_events (point_id, municipality_key, bucket, prev_bucket, risk, created_at)
     VALUES ${rows.join(', ')}`,
    values
  );
}

// NYT — dags-grupperet optælling af NYE varsel-episoder (bucket IN
// ('gul','roed')), til "Historik"-grafen på Overløb-fanen. Samme
// to_char(to_timestamp(...))-mønster som badested-observations.js's
// getVurderingTrendForBadestedIds() (created_at er BIGINT ms, ikke en
// DATE-kolonne).
async function getVarselTrendForMunicipality({ municipalityKey, fromMs, toMs }) {
  if (!municipalityKey) return [];
  const { rows } = await query(`
    SELECT to_char(to_timestamp(created_at / 1000.0), 'YYYY-MM-DD') AS date,
           COUNT(*) FILTER (WHERE bucket = 'gul')  AS gul,
           COUNT(*) FILTER (WHERE bucket = 'roed') AS roed
    FROM overloeb_status_events
    WHERE municipality_key = $1 AND bucket IN ('gul', 'roed') AND created_at > $2 AND created_at <= $3
    GROUP BY date
    ORDER BY date
  `, [municipalityKey, fromMs, toMs]);
  return rows.map(r => ({ date: r.date, gul: Number(r.gul), roed: Number(r.roed) }));
}

// NYT — pr.-punkt optælling af NYE varsel-episoder i perioden, til den
// prioriterede liste ("flest varsler" / "størst estimeret udledning" —
// sidstnævnte beregnes af kalderen, se server.js, ved at gange `total` med
// punktets meanVolumePerEvent, som IKKE gemmes her, se overloeb-status.js's
// filhoved for samme "join mod allerede-i-hukommelsen PULS-metadata i
// stedet for at duplikere et næsten-konstant tal pr. hændelse"-begrundelse.
async function getVarselCountsByPoint({ municipalityKey, fromMs, toMs }) {
  if (!municipalityKey) return [];
  const { rows } = await query(`
    SELECT point_id,
           COUNT(*) FILTER (WHERE bucket = 'gul')  AS gul,
           COUNT(*) FILTER (WHERE bucket = 'roed') AS roed
    FROM overloeb_status_events
    WHERE municipality_key = $1 AND bucket IN ('gul', 'roed') AND created_at > $2 AND created_at <= $3
    GROUP BY point_id
  `, [municipalityKey, fromMs, toMs]);
  return rows.map(r => ({ pointId: r.point_id, gul: Number(r.gul), roed: Number(r.roed), total: Number(r.gul) + Number(r.roed) }));
}

module.exports = {
  ready,
  recordTransitions,
  getVarselTrendForMunicipality,
  getVarselCountsByPoint,
};
