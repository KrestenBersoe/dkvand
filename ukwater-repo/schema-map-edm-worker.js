#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// schema-map-edm-worker.js — one OS thread's share of a Southern Water EDM
// "release history" export, see scripts/schema-map-edm.js's filehead for the
// full pipeline this is one stage of.
//
// Reads its assigned [start,end) BYTE range (already row-aligned, never
// splitting a row — see lib/csv-stream.js's findRowAlignedSplitPoints()) via
// fs.createReadStream({start,end}), preceded by the header row so field
// lookup is by name, not fixed position (robust against Southern Water
// reordering columns between exports — same principle as dkvand's own CSV
// ingestion). Maps every row into the clean schema, returns two record
// sets — one row per discharge EVENT (deduplicated: the source CSV repeats
// identical outfall/start/end/duration fields once per assessed bathing
// water) and one row per (event, bathing water) IMPACT assessment — plus
// diagnostic counts, via postMessage.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const { parentPort, workerData } = require('worker_threads');
const { streamCsvRows } = require('./lib/csv-stream');

const { filePath, headerEndOffset, range, header, workerIndex } = workerData;

function idx(name) {
  const i = header.indexOf(name);
  if (i === -1) throw new Error(`Column "${name}" not found in header: ${header.join(', ')}`);
  return i;
}
const COL = {
  outfall: idx('Outfall'),
  status: idx('Status'),
  startUnix: idx('Start (Unix)'),
  startFmt: idx('Start (Formatted)'),
  endUnix: idx('End (Unix)'),
  endFmt: idx('End (Formatted)'),
  endedStatus: idx('Ended Status'),
  duration: idx('Duration'),
  bathingWater: idx('Bathing Water'),
  impactStatus: idx('Impact Status'),
  eventId: idx('Event ID'),
  tidalModelVersion: idx('Tidal_Model_Version'),
  durationSeconds: idx('Duration (Seconds)'),
  lat: idx('Latitude'),
  lng: idx('Longitude'),
};

function parseIntOrNull(s) {
  const t = (s || '').trim();
  if (t === '') return null;
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
}
function parseFloatOrNull(s) {
  const t = (s || '').trim();
  if (t === '') return null;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

(async () => {
  try {
    // fs.createReadStream's `end` option is INCLUSIVE of the byte at that
    // offset (Node's own documented behavior) — subtract 1 so our exclusive
    // [start,end) range from findRowAlignedSplitPoints() maps correctly,
    // otherwise every worker except the last would read one byte into the
    // next worker's range (harmless here since that byte is mid-row and
    // gets silently absorbed by whichever worker's stream reads it LAST to
    // close, but wrong in principle and worth getting right).
    const [rangeStart, rangeEnd] = range;
    const bodyStream = fs.createReadStream(filePath, { start: rangeStart, end: rangeEnd - 1, encoding: 'utf8' });

    // Prepend the header line so streamCsvRows() parses field-complete rows
    // exactly as it would from row 1 of the whole file — an async generator
    // wrapping [headerLine, ...bodyChunks] as its own async-iterable input.
    const headerLine = header.join(',') + '\n'; // re-serialized only to feed the SAME parser used for the body; never written to disk
    async function* prefixedInput() {
      yield headerLine;
      for await (const chunk of bodyStream) yield chunk;
    }

    const events = new Map(); // eventId -> event record (dedup across its multiple bathing-water rows)
    const impacts = [];
    let rowCount = 0;
    let firstRow = true;
    const statusCounts = { Genuine: 0, 'Not Genuine': 0, 'Under Review': 0, other: 0 };
    const endedCounts = { Ended: 0, Ongoing: 0, other: 0 };
    let malformedRowCount = 0;
    const malformedExamples = [];

    for await (const fields of streamCsvRows(prefixedInput(), ',')) {
      if (firstRow) { firstRow = false; continue; } // the header row we just re-fed in
      rowCount++;
      if (fields.length <= COL.lng) {
        malformedRowCount++;
        if (malformedExamples.length < 3) malformedExamples.push(fields.join('|').slice(0, 200));
        continue;
      }

      const status = (fields[COL.status] || '').trim();
      statusCounts[Object.prototype.hasOwnProperty.call(statusCounts, status) && status !== 'other' ? status : 'other']++;

      const endedStatus = (fields[COL.endedStatus] || '').trim();
      endedCounts[Object.prototype.hasOwnProperty.call(endedCounts, endedStatus) && endedStatus !== 'other' ? endedStatus : 'other']++;

      const eventId = (fields[COL.eventId] || '').trim();
      if (!events.has(eventId)) {
        const startUnix = parseIntOrNull(fields[COL.startUnix]);
        const endUnix = parseIntOrNull(fields[COL.endUnix]);
        events.set(eventId, {
          eventId,
          outfall: (fields[COL.outfall] || '').trim(),
          lat: parseFloatOrNull(fields[COL.lat]),
          lng: parseFloatOrNull(fields[COL.lng]),
          status,
          genuine: status === 'Genuine',
          startTsMs: startUnix != null ? startUnix * 1000 : null,
          startFormatted: (fields[COL.startFmt] || '').trim() || null,
          endTsMs: endUnix != null ? endUnix * 1000 : null,
          endFormatted: (fields[COL.endFmt] || '').trim() || null,
          endedStatus, // 'Ended' | 'Ongoing' — see filehead: an 'Ongoing' event's endTsMs/durationSeconds are NOT yet final, don't treat them as known-at-T features in any backtest
          durationLabel: (fields[COL.duration] || '').trim() || null,
          durationSeconds: parseIntOrNull(fields[COL.durationSeconds]),
          tidalModelVersion: (fields[COL.tidalModelVersion] || '').trim() || null,
        });
      }

      const bathingWater = (fields[COL.bathingWater] || '').trim();
      if (bathingWater && bathingWater !== 'Not Applicable') {
        impacts.push({
          eventId,
          bathingWater,
          impactStatus: (fields[COL.impactStatus] || '').trim() || null,
        });
      }
    }

    parentPort.postMessage({
      type: 'done',
      workerIndex,
      events: [...events.values()],
      impacts,
      diagnostics: { rowCount, statusCounts, endedCounts, malformedRowCount, malformedExamples },
    });
  } catch (err) {
    parentPort.postMessage({ type: 'fatal', workerIndex, error: err.message, stack: err.stack });
  }
})();
