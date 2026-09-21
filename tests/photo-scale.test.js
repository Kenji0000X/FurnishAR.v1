import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scaleFromReference, measure, squareness, wallsToCorners, KNOWN_OBJECTS
} from '../lib/spatial/photo-scale.mjs';
import { roomDimensions } from '../lib/spatial/room.mjs';
import { surfacesFromCorners } from '../lib/spatial/clinometer.mjs';

const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

test('an A4 long edge over 297 pixels makes one pixel one millimetre', () => {
  const { metresPerPixel } = scaleFromReference({
    a: { x: 0, y: 0 }, b: { x: 297, y: 0 }, realMetres: 0.297
  });
  assert.ok(close(metresPerPixel, 0.001, 1e-9), `${metresPerPixel}`);
});

test('the scale is diagonal-aware, not just horizontal', () => {
  // A 3-4-5 triangle: the line is 500 px long however it is drawn.
  const { metresPerPixel } = scaleFromReference({
    a: { x: 0, y: 0 }, b: { x: 300, y: 400 }, realMetres: 0.5
  });
  assert.ok(close(metresPerPixel, 0.001, 1e-9), `${metresPerPixel}`);
});

test('a reference drawn too short is refused, with the cost spelled out', () => {
  const tiny = scaleFromReference({ a: { x: 0, y: 0 }, b: { x: 20, y: 0 }, realMetres: 0.297 });
  assert.equal(tiny.metresPerPixel, null);
  // 297 mm over 20 px is about 15 mm per pixel, and it says so.
  assert.match(tiny.reason, /15 mm of error/);
});

test('a measured line scales from the reference', () => {
  const scale = scaleFromReference({ a: { x: 0, y: 0 }, b: { x: 297, y: 0 }, realMetres: 0.297 });
  const { metres } = measure({
    a: { x: 0, y: 0 }, b: { x: 2970, y: 0 },
    metresPerPixel: scale.metresPerPixel, referencePixels: scale.pixels
  });
  assert.ok(close(metres, 2.97, 1e-9), `${metres}`);
});

test('a small reference poisons long measurements, and the spread says so', () => {
  /*
     The point of carrying referencePixels. Measuring a 3 m wall is the same
     arithmetic either way, but the DOUBT is not: scaling up from a bank card
     multiplies every pixel of tap error in the reference across the whole
     wall.
  */
  const card = scaleFromReference({ a: { x: 0, y: 0 }, b: { x: 60, y: 0 }, realMetres: 0.0856 });
  const sheet = scaleFromReference({ a: { x: 0, y: 0 }, b: { x: 400, y: 0 }, realMetres: 0.297 });

  const line = { a: { x: 0, y: 0 }, b: { x: 2000, y: 0 } };
  const fromCard = measure({ ...line, metresPerPixel: card.metresPerPixel, referencePixels: card.pixels });
  const fromSheet = measure({ ...line, metresPerPixel: sheet.metresPerPixel, referencePixels: sheet.pixels });

  assert.ok(fromCard.spread > fromSheet.spread * 3,
    `card ${fromCard.spread} should dwarf sheet ${fromSheet.spread}`);
  assert.equal(fromCard.trust, 'coarse');
  assert.equal(fromSheet.trust, 'good');
});

test('no scale means no measurement', () => {
  const none = measure({ a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, metresPerPixel: null });
  assert.equal(none.metres, null);
  assert.match(none.reason, /scale/i);
});

test('a square-on rectangle reads square', () => {
  const r = squareness([
    { x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }
  ]);
  assert.equal(r.verdict, 'square');
  assert.ok(close(r.skew, 0, 1e-9));
});

test('a photo shot from well off to one side is rejected, not silently stretched', () => {
  // Strong perspective: the far edge of the rectangle is half the near one.
  const r = squareness([
    { x: 0, y: 0 }, { x: 400, y: 0 }, { x: 300, y: 300 }, { x: 100, y: 300 }
  ]);
  assert.equal(r.verdict, 'bad');
  assert.match(r.reason, /stand square/i);
});

test('a slight angle is allowed but flagged', () => {
  // Top edge 400 px, bottom 340: a 15% skew, comfortably inside the
  // tilted band. (An earlier version of this fixture was 400/360 — exactly
  // 10% — which sits on the boundary and is correctly called square.)
  const r = squareness([
    { x: 0, y: 0 }, { x: 400, y: 0 }, { x: 370, y: 300 }, { x: 30, y: 300 }
  ]);
  assert.equal(r.verdict, 'tilted');
  assert.ok(r.skew > 0.10 && r.skew <= 0.25, `${r.skew}`);
});

test('four photographed wall lengths become a room', () => {
  const corners = wallsToCorners([4, 3, 4, 3]);
  const room = roomDimensions(surfacesFromCorners(corners, { ceilingHeight: 2.4 }), { minFloorArea: 0.5 });
  assert.ok(close(Math.max(room.length, room.width), 4, 0.01), `${room.length}`);
  assert.ok(close(Math.min(room.length, room.width), 3, 0.01), `${room.width}`);
  assert.ok(close(room.floorArea, 12, 0.05), `${room.floorArea}`);
});

test('fewer than three walls is not a room', () => {
  assert.deepEqual(wallsToCorners([4, 3]), []);
  assert.deepEqual(wallsToCorners([]), []);
});

test('every listed reference object has a real size, except the custom one', () => {
  for (const item of KNOWN_OBJECTS) {
    if (item.id === 'custom') { assert.equal(item.metres, null); continue; }
    assert.ok(item.metres > 0 && item.metres < 3, `${item.id} = ${item.metres}`);
    assert.ok(item.label.length > 3);
  }
});
