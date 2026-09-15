'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { verifySignature } = require('./watershed-live-sync');

function sign(body, secret) {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

test('accepts a correctly signed body', () => {
  const body = Buffer.from(JSON.stringify({ project: 'dkvand', datasets: [{ datasetKey: 'dmi-rain-history' }] }));
  assert.equal(verifySignature(body, sign(body, 's3cret'), 's3cret'), true);
});

test('rejects a signature made with a different secret', () => {
  const body = Buffer.from(JSON.stringify({ project: 'dkvand' }));
  assert.equal(verifySignature(body, sign(body, 'wrong-secret'), 's3cret'), false);
});

test('rejects a tampered body — signature no longer matches', () => {
  const body = Buffer.from(JSON.stringify({ project: 'dkvand', datasets: [{ datasetKey: 'dmi-rain-history' }] }));
  const validSig = sign(body, 's3cret');
  const tamperedBody = Buffer.from(JSON.stringify({ project: 'dkvand', datasets: [{ datasetKey: 'something-else' }] }));
  assert.equal(verifySignature(tamperedBody, validSig, 's3cret'), false);
});

test('rejects a missing signature header', () => {
  const body = Buffer.from('{}');
  assert.equal(verifySignature(body, undefined, 's3cret'), false);
});

test('rejects a header missing the sha256= prefix', () => {
  const body = Buffer.from('{}');
  const raw = crypto.createHmac('sha256', 's3cret').update(body).digest('hex');
  assert.equal(verifySignature(body, raw, 's3cret'), false);
});

test('rejects a mismatched-length signature without throwing', () => {
  const body = Buffer.from('{}');
  assert.doesNotThrow(() => verifySignature(body, 'sha256=tooshort', 's3cret'));
  assert.equal(verifySignature(body, 'sha256=tooshort', 's3cret'), false);
});
