/**
 * The catalogue filter.
 *
 * Two bugs lived here, and both were invisible from the UI because they only
 * showed up with data the demo catalogue does not contain:
 *
 *   1. The width slider's top stop is labelled "No limit" but still applied
 *      `width <= 240`, so any piece wider than 240 cm was hidden from every
 *      view, including the default one. With one sample product under 240 cm
 *      nothing looked wrong.
 *   2. Search never looked at the description, so a shopper searching for a
 *      material named only in the description got no results.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { matches, EMPTY_FILTERS as EMPTY } from '../app/catalog-filter.js';

const wideSofa = {
  name: 'Balayan Sectional',
  store: 'S&C Variety Store',
  storeId: 'sc-variety',
  category: 'Sofa',
  style: 'Modern',
  color: 'Natural',
  description: 'A long rattan sectional for a wide living room.',
  dimensions: { width: 260, height: 80, depth: 95 }
};

const narrowChair = {
  name: 'Walnut Armchair',
  store: 'Tiampion Buildings',
  storeId: 'tiampion',
  category: 'Chair',
  style: 'Classic',
  color: 'Walnut',
  description: 'Solid mahogany frame.',
  dimensions: { width: 70, height: 95, depth: 72 }
};

test('a piece wider than the slider maximum is still shown at "No limit"', () => {
  // The regression: this returned false, so a 260 cm sofa was unreachable.
  assert.equal(matches(wideSofa, EMPTY), true);
});

test('the width filter still excludes once it is actually moved', () => {
  assert.equal(matches(wideSofa, { ...EMPTY, width: 200 }), false);
  assert.equal(matches(narrowChair, { ...EMPTY, width: 200 }), true);
});

test('search reaches the description, not just the name', () => {
  assert.equal(matches(wideSofa, { ...EMPTY, search: 'rattan' }), true);
  assert.equal(matches(narrowChair, { ...EMPTY, search: 'rattan' }), false);
});

test('multiple words match in any order and any field', () => {
  assert.equal(matches(wideSofa, { ...EMPTY, search: 'rattan sofa' }), true);
  assert.equal(matches(wideSofa, { ...EMPTY, search: 'sofa rattan' }), true);
  // One term missing means no match, so search narrows rather than widens.
  assert.equal(matches(wideSofa, { ...EMPTY, search: 'rattan mahogany' }), false);
});

test('an empty search matches everything', () => {
  assert.equal(matches(wideSofa, EMPTY), true);
  assert.equal(matches(narrowChair, EMPTY), true);
});

test('whitespace-only search is not treated as a term', () => {
  assert.equal(matches(narrowChair, { ...EMPTY, search: '   ' }), true);
});

test('a product with no dimensions does not throw', () => {
  const noDimensions = { ...narrowChair, dimensions: undefined };
  assert.equal(matches(noDimensions, { ...EMPTY, width: 200 }), true);
});

test('store and category filters still apply', () => {
  assert.equal(matches(wideSofa, { ...EMPTY, store: 'sc-variety' }), true);
  assert.equal(matches(wideSofa, { ...EMPTY, store: 'tiampion' }), false);
  assert.equal(matches(wideSofa, { ...EMPTY, category: 'Sofa' }), true);
  assert.equal(matches(wideSofa, { ...EMPTY, category: 'Chair' }), false);
});
