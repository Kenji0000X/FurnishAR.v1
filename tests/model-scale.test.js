/**
 * How big a model is, tested against answers known in advance.
 *
 * The property that matters most here is the negative one: NO input, however
 * malformed, may produce a non-uniform scale. A test that only checked happy
 * paths would have passed against the implementation this replaces, which
 * stretched geometry on every single load.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyUnits, resolveScale, PLAUSIBLE_METRES } from '../lib/spatial/model-scale.mjs';

const extent = (width, depth, height) => ({ width, depth, height });

test('a metre-authored armchair is recognised as metres', () => {
  const units = classifyUnits(extent(0.793, 0.885, 1.0));
  assert.equal(units.unit, 'metres');
  assert.equal(units.factor, 1);
  assert.equal(units.confident, true);
});

test('a centimetre-authored export is recognised, not taken at face value', () => {
  // The same chair exported from a package whose unit is the centimetre.
  const units = classifyUnits(extent(79.3, 88.5, 100));
  assert.equal(units.unit, 'centimetres');
  assert.equal(units.factor, 0.01);
});

test('a millimetre-authored export is recognised', () => {
  const units = classifyUnits(extent(793, 885, 1000));
  assert.equal(units.unit, 'millimetres');
  assert.equal(units.factor, 0.001);
});

test('a model with no believable reading is refused, not guessed at', () => {
  // The real modern-living-room.glb in this repo. Nothing is 32 km wide, and
  // nothing here is willing to pick a factor for it.
  const decision = resolveScale({
    meshExtent: extent(32099, 27389, 15228),
    declaredCm: { width: 200, depth: 90, height: 75 }
  });
  assert.equal(decision.usable, false);
  assert.equal(decision.scale, null);
  assert.equal(decision.verdict, 'unknown-units');
  assert.match(decision.message, /could not be determined/);
});

test('degenerate geometry is refused rather than divided by', () => {
  for (const bad of [extent(0, 0, 0), extent(NaN, 1, 1), extent(-1, -1, -1)]) {
    const decision = resolveScale({ meshExtent: bad, declaredCm: { width: 70, depth: 78, height: 88 } });
    assert.equal(decision.usable, false, `${JSON.stringify(bad)} should be unusable`);
  }
});

test('the mesh is the measurement; the typed dimensions are a cross-check', () => {
  // The real cane-back armchair: mesh says 79.3 x 88.5 x 100.0, listing says
  // 70 x 78 x 88. The mesh wins, and the disagreement is reported.
  const decision = resolveScale({
    meshExtent: extent(0.793, 0.885, 1.0),
    declaredCm: { width: 70, depth: 78, height: 88 }
  });
  assert.equal(decision.usable, true);
  assert.equal(decision.scale, 1, 'a metre-authored model needs no scaling at all');
  assert.equal(decision.source, 'model');
  assert.equal(decision.verdict, 'differs');
  assert.deepEqual(decision.actualCm, { width: 79.3, depth: 88.5, height: 100 });
  assert.match(decision.message, /79\.3 × 88\.5 × 100 cm/);
  assert.match(decision.message, /Check which is right/);
});

test('a listing within 5% of its model is left alone', () => {
  const decision = resolveScale({
    meshExtent: extent(0.793, 0.885, 1.0),
    declaredCm: { width: 79, depth: 89, height: 100 }
  });
  assert.equal(decision.verdict, 'agrees');
  assert.ok(decision.agreement < 0.05);
});

test('a confirmed override sets the size, still with one factor', () => {
  // Same proportions as the mesh, twice as big.
  const decision = resolveScale({
    meshExtent: extent(0.793, 0.885, 1.0),
    declaredCm: { width: 70, depth: 78, height: 88 },
    overrideCm: { width: 158.6, depth: 177, height: 200 }
  });
  assert.equal(decision.source, 'confirmed-override');
  assert.equal(decision.verdict, 'agrees');
  assert.ok(Math.abs(decision.scale - 2) < 1e-6, `expected ~2, got ${decision.scale}`);
});

test('an override with the wrong proportions is honoured approximately, never by stretching', () => {
  // Asks for a chair twice as wide but the same height — impossible without
  // distorting it, which is the one thing that must not happen.
  const decision = resolveScale({
    meshExtent: extent(0.793, 0.885, 1.0),
    declaredCm: { width: 70, depth: 78, height: 88 },
    overrideCm: { width: 158.6, depth: 88.5, height: 100 }
  });
  assert.equal(decision.verdict, 'distorted-override');
  assert.match(decision.message, /rather than stretched to fit/);
  // The proportions of what is rendered still match the mesh exactly.
  const m = extent(0.793, 0.885, 1.0);
  const a = decision.actualCm;
  assert.ok(Math.abs((a.width / a.height) - (m.width / m.height)) < 1e-3);
  assert.ok(Math.abs((a.depth / a.height) - (m.depth / m.height)) < 1e-3);
});

/* ------------------------------------------------------------------------ */
/* The property that the old implementation violated on every single load.   */
/* ------------------------------------------------------------------------ */

test('no input of any shape can produce a non-uniform scale', () => {
  const meshes = [
    extent(0.793, 0.885, 1.0),
    extent(2.4, 0.9, 0.75),
    extent(0.3, 0.3, 0.42),
    extent(79.3, 88.5, 100),
    extent(1200, 800, 750)
  ];
  const declarations = [
    { width: 70, depth: 78, height: 88 },
    { width: 1, depth: 999, height: 40 },      // nonsense, on purpose
    { width: 240, depth: 90, height: 75 }
  ];
  const overrides = [null, { width: 500, depth: 1, height: 22 }, { width: 80, depth: 90, height: 100 }];

  for (const meshExtent of meshes) {
    for (const declaredCm of declarations) {
      for (const overrideCm of overrides) {
        const decision = resolveScale({ meshExtent, declaredCm, overrideCm });
        if (!decision.usable) continue;

        // One number, applied to three axes. That single factor IS the
        // uniformity guarantee — geometry is scaled by `scale`, so the
        // rendered proportions cannot differ from the mesh's.
        assert.equal(typeof decision.scale, 'number');
        assert.ok(decision.scale > 0 && Number.isFinite(decision.scale));

        // And the reported size is that same factor, rounded to the
        // millimetre for display — not an independently computed box. This is
        // what stops a "reported" size drifting away from the rendered one.
        for (const axis of ['width', 'depth', 'height']) {
          const exact = meshExtent[axis] * decision.scale * 100;
          assert.ok(
            Math.abs(decision.actualCm[axis] - exact) <= 0.05 + 1e-9,
            `${axis}: reported ${decision.actualCm[axis]} cm is not ${exact.toFixed(4)} cm rounded`
          );
        }
      }
    }
  }
});

test('anything declared usable lands inside the believable range', () => {
  for (const longest of [0.05, 0.3, 1, 2.4, 5, 30, 300, 3000, 32099]) {
    const decision = resolveScale({
      meshExtent: extent(longest, longest * 0.4, longest * 0.5),
      declaredCm: { width: 100, depth: 40, height: 50 }
    });
    if (!decision.usable) continue;
    const metres = Math.max(decision.actualCm.width, decision.actualCm.depth, decision.actualCm.height) / 100;
    assert.ok(
      metres >= PLAUSIBLE_METRES.min && metres <= PLAUSIBLE_METRES.max,
      `${longest} units resolved to ${metres} m, outside the believable range`
    );
  }
});
