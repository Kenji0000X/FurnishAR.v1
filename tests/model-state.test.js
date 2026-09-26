/**
 * Which products the public collection may show as real cards
 * (app/model-state.js): a model a shopper can see, or one whose picture is
 * being made right now. Placeholders fill up to three slots and are never
 * products.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { previewState, isListable, placeholderSlots, PREVIEW_GRACE_MS } from '../app/model-state.js';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const ago = ms => new Date(NOW - ms).toISOString();

test('a model with its poster is a real card', () => {
  const p = { modelGlb: '/api/sb/model/s/p/m.glb', thumbnail: 'https://x/poster.webp' };
  assert.equal(previewState(p, NOW), 'ready');
  assert.equal(isListable(p, NOW), true);
});

test('a model uploaded moments ago without a poster is "preparing" and listed', () => {
  const p = { modelGlb: '/m.glb', thumbnail: null, modelUploadedAt: ago(60 * 1000) };
  assert.equal(previewState(p, NOW), 'preparing');
  assert.equal(isListable(p, NOW), true);
});

test('a model with no poster past the grace window is not listed (nothing is preparing it)', () => {
  const p = { modelGlb: '/m.glb', thumbnail: null, modelUploadedAt: ago(PREVIEW_GRACE_MS + 1000) };
  assert.equal(previewState(p, NOW), 'missing');
  assert.equal(isListable(p, NOW), false);
  assert.equal(isListable({ modelGlb: '/m.glb', thumbnail: null }, NOW), false, 'no upload time: not preparing');
});

test('no model is never listed, whatever the row claims', () => {
  assert.equal(isListable({ arReady: true, thumbnail: 'https://x/p.webp' }, NOW), false);
  assert.equal(isListable({ imageUrl: 'https://x/photo.jpg' }, NOW), false);
  assert.equal(isListable({}, NOW), false);
});

test('placeholders fill up to three slots, and only up to three', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 10].map(placeholderSlots), [3, 2, 1, 0, 0, 0]);
  assert.equal(placeholderSlots(undefined), 3);
});

test('used as a filter callback, the index is not mistaken for the time', () => {
  const fresh = { modelGlb: '/m.glb', thumbnail: null, modelUploadedAt: new Date().toISOString() };
  assert.deepEqual([fresh, fresh].filter(p => isListable(p)).length, 2);
});
