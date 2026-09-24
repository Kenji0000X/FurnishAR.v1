/**
 * One piece of furniture, one size, everywhere it is written.
 *
 * Field recordings showed a product header and the floating AR chip giving
 * different dimensions for the same piece. The cause was two independent size
 * sources (product.dimensions and a separate "model bounds"), and surfaces
 * that each formatted their own. This holds the contract:
 *
 *   - product.dimensions (width_cm / depth_cm / height_cm) is the size;
 *   - every shopper surface writes it through formatDimensions();
 *   - the model is scaled to it (model-transform), the fit check reads it,
 *     and nothing derives a displayed size from model geometry.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { formatDimensions, formatFootprint, dimensionsToMeters } from '../lib/spatial/units.mjs';
import { normalizeModel, measure } from '../lib/spatial/model-transform.mjs';
import { fitAgainstClearance, fitAgainstArea } from '../public/geometry.js';
import { fitInRoom, roomDimensions } from '../lib/spatial/room.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const PRODUCTS = [
  { name: 'Side table', dimensions: { width: 31, depth: 35, height: 29 }, text: '31 × 35 × 29 cm' },
  { name: 'Stool', dimensions: { width: 11, depth: 11, height: 24 }, text: '11 × 11 × 24 cm' }
];

/* A model deliberately exported at the wrong scale and with a different
   origin, so any surface that read the MESH would disagree. */
function modelFor({ width, depth, height }, exportScale = 37) {
  const g = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(width * exportScale, height * exportScale, depth * exportScale));
  box.position.set(5, 3, -2);
  g.add(box);
  return g;
}

for (const product of PRODUCTS) {
  test(`${product.text}: every surface expresses the same physical size`, () => {
    // Product page, planner card, AR header, spatial chip: one formatter.
    assert.equal(formatDimensions(product.dimensions, 'cm'), product.text);
    // The fit plan's footprint label is the same width and depth.
    assert.equal(formatFootprint(product.dimensions, 'cm'), product.text.replace(/ × [\d.]+ cm$/, ' cm'));

    // The model is scaled to exactly this size, whatever its export units.
    const model = modelFor(product.dimensions);
    const { verified, finalMeters } = normalizeModel(THREE, model, product.dimensions);
    assert.equal(verified, true);
    const expected = dimensionsToMeters(product.dimensions);
    for (const axis of ['width', 'depth', 'height']) {
      assert.ok(Math.abs(finalMeters[axis] - expected[axis]) < 1e-6, `${axis} ${finalMeters[axis]} vs ${expected[axis]}`);
    }
    // X is width, Y height, Z depth, measured on the normalised model itself.
    const { extent } = measure(THREE, model);
    assert.ok(Math.abs(extent.width - expected.width) < 1e-6);
    assert.ok(Math.abs(extent.height - expected.height) < 1e-6);
    assert.ok(Math.abs(extent.depth - expected.depth) < 1e-6);

    // The fit checker reads the same numbers.
    const clearance = fitAgainstClearance(product.dimensions, product.dimensions.width + 5);
    assert.equal(clearance.fits, true);
    assert.equal(fitAgainstClearance(product.dimensions, product.dimensions.width + 4).fits, false);
    const area = fitAgainstArea(product.dimensions, (product.dimensions.width * product.dimensions.depth) / 10000);
    assert.ok(Math.abs(area.footprint - (product.dimensions.width * product.dimensions.depth) / 10000) < 1e-9);
    const room = roomDimensions([{ orientation: 'horizontal', polygon: [
      { x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 2, y: 0, z: 2 }, { x: 0, y: 0, z: 2 }] }], { minFloorArea: 0.5 });
    assert.equal(fitInRoom(room, expected).fits, true);
  });
}

test('every shopper surface writes a size through formatDimensions, never by hand', () => {
  const engine = read('app/plan/ar-engine.js');
  // AR header.
  assert.match(engine, /\$\('#ar-product-dims'\)\.textContent = formatDimensions\(product\.dimensions, 'cm'\)/);
  // Planner card choices.
  assert.match(engine, /formatDimensions\(item\.dimensions, 'cm'\)/);
  // The chip over the model reads the product's dimensions, not the model's box.
  assert.match(engine, /formatDimensions\(product\.dimensions, state\.dimensionUnit\)/);
  // No hand-assembled "W × D × H" from raw numbers anywhere on a shopper surface.
  const handMade = /\$?\{(?:cm\()?[a-zA-Z]*\.dimensions\.width\)?\}\s*(?:W\s*)?×\s*\$?\{(?:cm\()?[a-zA-Z]*\.dimensions\.depth/;
  for (const file of ['app/plan/ar-engine.js', 'app/furniture/[slug]/page.js', 'app/portal/Portal.js']) {
    assert.doesNotMatch(read(file), handMade, file);
  }
  assert.match(read('app/furniture/[slug]/page.js'), /formatDimensions\(product\.dimensions, 'cm'\)/);
});

test('no displayed size is derived from model geometry or legacy bounds', () => {
  const engine = read('app/plan/ar-engine.js');
  // The legacy bounds are never read for display or scale.
  assert.doesNotMatch(engine, /product\.modelBounds/);
  // The fit check and placement verdict use product.dimensions.
  assert.match(engine, /fitInRoom\(room, piece/);
  assert.match(engine, /width: product\.dimensions\.width \/ 100/);
  // The anonymous box stand-in is gone: no product-coloured cube is drawn as the piece.
  assert.doesNotMatch(engine, /fallbackRenderer\.draw/);
});
