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

  -- RETTET (bruger-krav 2026-08-20): "seneste kendte bucket pr. punkt" boede
  -- hidtil KUN i server.js's lastKnownBucketByPointId (en ren in-memory Map)
  -- — ethvert genstart/deploy nulstillede den til tom, hvilket betød det
  -- FØRSTE reelle skift efter genstart aldrig blev opdaget (shouldLogTransition()
  -- kræver en kendt forrige bucket, se dens filhoved). Denne tabel er den
  -- persisterede kilde: server.js indlæser den i lastKnownBucketByPointId
  -- ved opstart (se loadAllLastBuckets()) og skriver til den HVER GANG et
  -- punkts bucket ændrer sig (eller ses for allerførste gang) — se
  -- upsertLastBuckets(). Selve Map'en i hukommelsen er fortsat den HURTIGE
  -- læsesti hver cyklus (21.563 opslag/cyklus skal ikke ramme databasen),
  -- denne tabel er alene for holdbarhed på tværs af genstarter.
  CREATE TABLE IF NOT EXISTS puls_point_last_bucket (
    point_id   TEXT PRIMARY KEY,
    bucket     TEXT NOT NULL,
    updated_at BIGINT NOT NULL
  );
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

// NYT (bruger-krav 2026-08-20) — indlæser HELE puls_point_last_bucket ved
// serveropstart, ÉT kald (ikke pr. punkt), til server.js's
// lastKnownBucketByPointId. Kaldes FØR den periodiske evaluering (2s-
// opvarmningen, se server.js's tre warmCache()-kaldssteder) må røre Map'en
// — se _lastBucketsHydrated der.
async function loadAllLastBuckets() {
  const { rows } = await query(`SELECT point_id, bucket FROM puls_point_last_bucket`);
  return new Map(rows.map(r => [r.point_id, r.bucket]));
}

// NYT (bruger-krav 2026-08-20) — bulk-UPSERT, kaldt med KUN de punkter hvis
// bucket ændrede sig (eller ses for allerførste gang) i netop denne cyklus
// — samme filtrering som bucketTransitions ovenfor bruger til selve
// hændelsesloggen, blot uden shouldLogTransition()'s "kendt forrige
// bucket"-krav (en ny/aldrig-før-set punkt SKAL også gemmes, ellers
// gentager problemet sig for netop det punkt ved næste genstart). Batches
// i bidder af 5.000 rækker — langt under Postgres' ~65.535 bind-parameter-
// grænse (3 kolonner × 5.000 = 15.000), men rigeligt margin selv hvis
// antallet af ÆNDREDE punkter pr. cyklus en dag skulle blive usædvanligt
// stort (normalt kun en håndfuld til nogle hundrede, se kaldestedet).
async function upsertLastBuckets(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  const BATCH = 5000;
  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    const values = [];
    const rows = batch.map((e, j) => {
      const base = j * 3;
      values.push(e.pointId, e.bucket, e.updatedAt);
      return `($${base + 1}, $${base + 2}, $${base + 3})`;
    });
    await query(
      `INSERT INTO puls_point_last_bucket (point_id, bucket, updated_at)
       VALUES ${rows.join(', ')}
       ON CONFLICT (point_id) DO UPDATE SET bucket = EXCLUDED.bucket, updated_at = EXCLUDED.updated_at`,
      values
    );
  }
}

module.exports = {
  ready,
  recordTransitions,
  getVarselTrendForMunicipality,
  getVarselCountsByPoint,
  loadAllLastBuckets,
  upsertLastBuckets,
};
