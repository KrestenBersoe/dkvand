'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  gridKey, buildDenmarkGrid, buildPulsGrid, isTransientOpenMeteoError, computeMetrics,
} = require('./open-meteo-weather');

test('gridKey buckets nearby points into the same 0.25° cell', () => {
  assert.equal(gridKey(55.676, 12.568), gridKey(55.680, 12.570));
});

test('gridKey separates points in different cells', () => {
  assert.notEqual(gridKey(55.6, 12.5), gridKey(56.1, 13.0));
});

test('buildDenmarkGrid covers Denmark+Bornholm at 0.25° with no duplicate cells', () => {
  const cells = buildDenmarkGrid();
  assert.ok(cells.length > 100);
  const keys = cells.map((c) => gridKey(c.lat, c.lng));
  assert.equal(new Set(keys).size, keys.length);
});

test('buildPulsGrid derives unique cells from real puls-data.json rows, deduped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puls-'));
  const file = path.join(dir, 'puls-data.json');
  // Two points in the same 0.25° cell, one far away — expect 2 cells, not 3.
  fs.writeFileSync(file, JSON.stringify({ d: [[55.676, 12.568], [55.680, 12.570], [57.0, 10.0]] }));
  const cells = buildPulsGrid(file);
  assert.equal(cells.length, 2);
});

test('buildPulsGrid falls back to the Denmark bbox grid when the file is missing', () => {
  const cells = buildPulsGrid('/nonexistent/puls-data.json');
  assert.deepEqual(cells, buildDenmarkGrid());
});

test('isTransientOpenMeteoError is true only for 502/503/504', () => {
  assert.equal(isTransientOpenMeteoError(new Error('Open-Meteo HTTP 503')), true);
  assert.equal(isTransientOpenMeteoError(new Error('Open-Meteo HTTP 502')), true);
  assert.equal(isTransientOpenMeteoError(new Error('Open-Meteo HTTP 504')), true);
  assert.equal(isTransientOpenMeteoError(new Error('Open-Meteo HTTP 429')), false);
  assert.equal(isTransientOpenMeteoError(new Error('Open-Meteo HTTP 404')), false);
  assert.equal(isTransientOpenMeteoError(new Error('network error')), false);
});

test('computeMetrics sums observed rain into todayMM and forecast rain into forecastMM', () => {
  const now = new Date();
  const past = new Date(now.getTime() - 2 * 3600 * 1000).toISOString();
  const future = new Date(now.getTime() + 2 * 3600 * 1000).toISOString();
  const json = {
    hourly: {
      time: [past, future],
      precipitation: [3.5, 1.2],
      temperature_2m: [15, 16],
      windspeed_10m: [4, 5],
      winddirection_10m: [180, 190],
    },
  };
  const m = computeMetrics(json);
  assert.equal(m.todayMM, 3.5);
  assert.equal(m.forecastMM, 1.2);
  assert.ok(m.hourlyWeek.length >= 1);
  assert.ok(typeof m.antecedentMM === 'number');
});

test('computeMetrics handles an empty/malformed response without throwing', () => {
  assert.doesNotThrow(() => computeMetrics({}));
  const m = computeMetrics({});
  assert.equal(m.todayMM, 0);
  assert.equal(m.forecastMM, 0);
  assert.deepEqual(m.hourlyWeek, []);
});
