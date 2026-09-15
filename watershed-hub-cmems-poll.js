#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// watershed-hub-cmems-poll.js
// ═══════════════════════════════════════════════════════════════════════════
//
// One-shot Watershed hub adapter — runs the EXISTING, unchanged
// fetch_currents.py (same script server.js's own runPythonFetch() calls
// directly today) on the hub's own schedule instead of every dkvand replica
// independently re-fetching the same CMEMS Baltic/NWSHELF products on its
// own hourly timer. Direct sibling of ukwater's/frwater's own
// pipeline/lib/cmemsPoll.js. Deliberately a thin wrapper, not a rewrite of
// fetch_currents.py itself — that script is shared, unchanged, with the
// per-app direct-fetch path, so nothing here can drift from what a non-hub
// deployment still does.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const OUT_PATH = path.join(__dirname, 'currents-hub.json');
const PYTHON_SCRIPT = path.join(__dirname, 'fetch_currents.py');
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const PYTHON_TIMEOUT = 180 * 1000; // matches server.js's own PYTHON_TIMEOUT

// Same CPU-niceness as server.js's own runPythonFetch() — harmless here
// (the hub isn't competing with a request-serving event loop the way a
// live app replica is), kept for consistency with the one, shared script's
// expectations.
const PYTHON_ENV = {
  ...process.env,
  OMP_NUM_THREADS: '1',
  OPENBLAS_NUM_THREADS: '1',
  MKL_NUM_THREADS: '1',
  NUMEXPR_NUM_THREADS: '1',
};

function runPythonFetch() {
  return new Promise((resolve, reject) => {
    execFile(
      'nice',
      ['-n', '19', PYTHON_BIN, PYTHON_SCRIPT],
      { timeout: PYTHON_TIMEOUT, maxBuffer: 32 * 1024 * 1024, env: PYTHON_ENV },
      (err, stdout, stderr) => {
        if (stderr && stderr.trim()) {
          console.warn('[watershed-hub-cmems-poll] fetch_currents.py stderr:', stderr.trim().slice(0, 500));
        }
        let parsed;
        try {
          parsed = JSON.parse((stdout || '').trim());
        } catch (parseErr) {
          return reject(new Error(err ? `python failed: ${err.message}` : `invalid output: ${parseErr.message}`));
        }
        if (parsed.error) return reject(new Error(parsed.error));
        resolve(parsed);
      }
    );
  });
}

async function main() {
  const result = await runPythonFetch();
  if (!result.points || !result.points.length) throw new Error('no current points received');

  fs.writeFileSync(OUT_PATH, JSON.stringify(result));
  console.log(`[watershed-hub-cmems-poll] ${result.points.length} points fetched -> ${OUT_PATH}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[watershed-hub-cmems-poll] failed:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
