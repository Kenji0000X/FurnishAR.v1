/**
 * Photo measurement with the perspective removed. A synthetic camera looks at
 * a wall from an angle; the reference and the measured line are projected
 * through it, and the homography must recover the real length.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { homographyFrom, applyHomography, referencePlane, measureOnPlane, skewOf } from '../lib/spatial/homography.mjs';
import { scaleFromReference, measure } from '../lib/spatial/photo-scale.mjs';

/** A pinhole camera at distance d from a wall, turned by yaw degrees. */
function camera({ yaw = 0, pitch = 0, distance = 2.5, f = 1500, cx = 1000, cy = 750 }) {
  const a = yaw * Math.PI / 180, b = pitch * Math.PI / 180;
  return ({ x, y }) => {
    // Wall point (x right, y up) at z = 0; camera looks at the origin from +z.
    let px = x, py = y, pz = -distance;
    // Rotate the scene by yaw (about vertical) and pitch (about horizontal).
    [px, pz] = [px * Math.cos(a) - pz * Math.sin(a), px * Math.sin(a) + pz * Math.cos(a)];
    [py, pz] = [py * Math.cos(b) - pz * Math.sin(b), py * Math.sin(b) + pz * Math.cos(b)];
    const depth = -pz;
    return { x: cx + f * px / depth, y: cy - f * py / depth };
  };
}

const A4 = { width: 0.297, height: 0.210 };
const a4Corners = (at = { x: -0.15, y: 0.1 }) => [
  { x: at.x, y: at.y }, { x: at.x + A4.width, y: at.y },
  { x: at.x + A4.width, y: at.y + A4.height }, { x: at.x, y: at.y + A4.height }
];

test('a homography maps its four points exactly', () => {
  const src = [{ x: 10, y: 10 }, { x: 200, y: 30 }, { x: 180, y: 220 }, { x: 20, y: 190 }];
  const dst = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  const H = homographyFrom(src, dst);
  src.forEach((p, i) => {
    const q = applyHomography(H, p);
    assert.ok(Math.abs(q.x - dst[i].x) < 1e-9 && Math.abs(q.y - dst[i].y) < 1e-9);
  });
  assert.equal(homographyFrom([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }], dst), null);
});

test('square on: recovers a 2.00 m wall from an A4 reference', () => {
  const cam = camera({});
  const plane = referencePlane({ corners: a4Corners().map(cam), ...A4 });
  assert.ok(plane.ok, plane.reason);
  const r = measureOnPlane(plane, cam({ x: -1, y: 0.4 }), cam({ x: 1, y: 0.4 }));
  assert.ok(Math.abs(r.metres - 2.0) < 1e-6, String(r.metres));
});

test('30 degrees off square: the homography is still exact, the two-point method is not', () => {
  const cam = camera({ yaw: 30 });
  const refImage = a4Corners().map(cam);
  const plane = referencePlane({ corners: refImage, ...A4 });
  assert.ok(plane.ok, plane.reason);
  const a = cam({ x: -1, y: 0.4 }), b = cam({ x: 1, y: 0.4 });
  const fixed = measureOnPlane(plane, a, b);
  assert.ok(Math.abs(fixed.metres - 2.0) < 1e-6, `homography ${fixed.metres}`);

  // The old method: scale from the reference's top edge, measure the line.
  const scale = scaleFromReference({ a: refImage[0], b: refImage[1], realMetres: A4.width });
  const old = measure({ a, b, metresPerPixel: scale.metresPerPixel }).metres;
  assert.ok(Math.abs(old - 2.0) > 0.03, `the two-point method was off by only ${old - 2}`);
});

test('the spread is real: a small reference is less certain than a large one', () => {
  const cam = camera({ yaw: 15 });
  const a = cam({ x: -1, y: 0.4 }), b = cam({ x: 1, y: 0.4 });
  const card = referencePlane({ corners: [
    { x: -0.04, y: 0.1 }, { x: 0.0456, y: 0.1 }, { x: 0.0456, y: 0.154 }, { x: -0.04, y: 0.154 }
  ].map(cam), width: 0.0856, height: 0.054 });
  const tile = referencePlane({ corners: [
    { x: -0.3, y: 0 }, { x: 0.3, y: 0 }, { x: 0.3, y: 0.6 }, { x: -0.3, y: 0.6 }
  ].map(cam), width: 0.6, height: 0.6 });
  const withCard = measureOnPlane(card, a, b);
  const withTile = measureOnPlane(tile, a, b);
  assert.ok(withCard.spread > withTile.spread * 3, `${withCard.spread} vs ${withTile.spread}`);
  assert.equal(withCard.trust, 'coarse');
});

test('refuses crossed markings and photos taken far too obliquely', () => {
  const cam = camera({});
  const c = a4Corners().map(cam);
  const crossed = referencePlane({ corners: [c[0], c[2], c[1], c[3]], ...A4 });
  assert.equal(crossed.ok, false);
  assert.match(crossed.reason, /in order around the edge/);
  const oblique = referencePlane({ corners: a4Corners().map(camera({ yaw: 75, distance: 1 })), ...A4 });
  assert.equal(oblique.ok, false);
  assert.match(oblique.reason, /too much of an angle/);
  assert.ok(skewOf(a4Corners().map(camera({ yaw: 75, distance: 1 }))) > 0.35);
});

test('extrapolating far past the reference is flagged', () => {
  const cam = camera({ distance: 6, f: 3000 });
  const card = referencePlane({ corners: [
    { x: 0, y: 0 }, { x: 0.0856, y: 0 }, { x: 0.0856, y: 0.054 }, { x: 0, y: 0.054 }
  ].map(cam), width: 0.0856, height: 0.054 });
  const r = measureOnPlane(card, cam({ x: -2, y: 0 }), cam({ x: 2, y: 0 }));
  assert.equal(r.trust, 'coarse');
  assert.match(r.reason, /bigger reference/);
});
