#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// csv-stream.js — shared CSV-streaming helpers for the ukwater-repo EDM pipeline.
//
// Two responsibilities, both needed to safely parallelize a large CSV across
// worker_threads without ever splitting a logical row (or a quoted field
// containing an embedded newline) across two workers' byte ranges:
//
//   1. streamCsvRows() — citation-aware row generator. Same approach as
//      dkvand's scripts/build-badevand-analyseresultater.js (that file's own
//      header explains why line-by-line splitting is unsafe: a quoted field
//      can contain a real newline, which a naive readline-based split would
//      break mid-row). Reused here, not reinvented, because the same RFC4180
//      hazard applies to any CSV export, UK or Danish.
//   2. findRowAlignedSplitPoints() — a single fast BYTE-level pre-pass (not a
//      full decode/parse) that finds N-1 byte offsets which each fall
//      exactly at the start of a row, outside any quoted field — so that N
//      workers can each read a contiguous fs.createReadStream({start,end})
//      byte range and safely parse complete rows, no row ever split across
//      two workers. Splits are chosen at even ROW-COUNT intervals, not even
//      byte intervals, since per-row processing cost is roughly uniform —
//      this gives balanced work per worker, same principle as
//      validate-badevand-model.js's chunkContiguous() for dates.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');

async function* streamCsvRows(input, delimiter = ',') {
  let fields = [];
  let cur = '';
  let inQuotes = false;
  let firstChunk = true;

  function flushField() { fields.push(cur); cur = ''; }

  for await (let chunk of input) {
    if (firstChunk) {
      firstChunk = false;
      if (chunk.charCodeAt(0) === 0xFEFF) chunk = chunk.slice(1);
    }
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (inQuotes) {
        if (ch === '"') {
          if (chunk[i + 1] === '"') { cur += '"'; i++; }
          else inQuotes = false;
        } else {
          cur += ch;
        }
      } else if (ch === '"' && cur === '') {
        inQuotes = true;
      } else if (ch === delimiter) {
        flushField();
      } else if (ch === '\r') {
        // ignored — handles both \n and \r\n uniformly
      } else if (ch === '\n') {
        flushField();
        const row = fields;
        fields = [];
        yield row;
      } else {
        cur += ch;
      }
    }
  }
  if (cur !== '' || fields.length > 0) {
    flushField();
    yield fields;
  }
}

// Single sequential BYTE scan (not a full parse — just quote/newline state)
// over the whole file, recording the byte offset immediately after every
// Mth row-ending newline that occurs OUTSIDE a quoted field. Returns the
// header line's byte length plus a list of candidate row-start offsets,
// evenly spaced in ROW COUNT. STREAMED chunk-by-chunk (fs.createReadStream),
// deliberately NOT fs.readFileSync — a genuinely large export (this is the
// one pass that has to touch the whole file) should never require loading
// the entire CSV into memory just to find split points; peak memory here is
// one read chunk (64KB default) plus the sparse candidate-offset list, not
// the file size.
async function findRowAlignedSplitPoints(filePath, numWorkers, sampleEveryNRows = 2000) {
  let inQuotes = false;
  let rowCount = 0;
  let headerEndOffset = -1;
  let bytesSeen = 0;
  const candidates = []; // byte offsets, each exactly at the start of a row

  const stream = fs.createReadStream(filePath); // raw Buffer chunks, no decoding needed for a byte-level scan
  for await (const chunk of stream) {
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i];
      if (byte === 0x22 /* " */) {
        // Toggle only on unescaped quotes (a doubled "" inside a quoted
        // field is two toggles, net no-op — same result as the row
        // parser's own escape handling, without tracking pairs explicitly).
        inQuotes = !inQuotes;
      } else if (byte === 0x0A /* \n */ && !inQuotes) {
        rowCount++;
        const rowStart = bytesSeen + i + 1;
        if (headerEndOffset === -1) {
          headerEndOffset = rowStart; // end of the header line = start of row 1
        } else if ((rowCount - 1) % sampleEveryNRows === 0) {
          candidates.push(rowStart);
        }
      }
    }
    bytesSeen += chunk.length;
  }

  if (headerEndOffset === -1) throw new Error(`${filePath}: no header line found (file has no newline at all?)`);

  const totalDataRows = rowCount - 1; // minus the header row itself
  const fileSize = bytesSeen;
  const splits = [headerEndOffset];
  for (let w = 1; w < numWorkers; w++) {
    const idx = Math.floor((w * candidates.length) / numWorkers);
    splits.push(candidates[Math.min(idx, candidates.length - 1)] ?? fileSize);
  }
  splits.push(fileSize);
  // Dedupe (a very small file can produce fewer usable splits than workers)
  // and drop any resulting empty [start,end) range.
  const ranges = [];
  for (let i = 0; i < splits.length - 1; i++) {
    if (splits[i + 1] > splits[i]) ranges.push([splits[i], splits[i + 1]]);
  }
  return { headerEndOffset, totalDataRows, fileSize, ranges };
}

module.exports = { streamCsvRows, findRowAlignedSplitPoints };
