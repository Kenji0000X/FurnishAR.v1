/**
 * Catalogue filtering, kept apart from the component that renders it.
 *
 * This is pure data in, boolean out — no React, no JSX — so it can be tested
 * directly by `node --test` without a bundler or a DOM. That is the whole
 * reason it lives in its own file: the two bugs fixed here were both invisible
 * from the browser with the sample catalogue, and only a unit test with the
 * right data proves they are gone.
 */

/** The top of the width slider. At this value the filter means "no limit". */
export const NO_LIMIT = 240;

export const EMPTY_FILTERS = {
  search: '',
  category: '',
  store: '',
  width: NO_LIMIT,
  color: '',
  /* Only pieces with a real uploaded model. The single most useful filter on
     a site whose whole promise is "see it in your room" — and one a shopper
     can only apply if the catalogue is honest about which pieces have one. */
  modelOnly: false,
  /* Hide what the shop has none of. */
  inStockOnly: false
};

/** How the grid can be ordered. Sort is a filter's other half. */
export const SORTS = {
  relevance: { label: 'Featured first', compare: null },
  'price-asc': { label: 'Price, low to high', compare: (a, b) => a.price - b.price },
  'price-desc': { label: 'Price, high to low', compare: (a, b) => b.price - a.price },
  'width-asc': {
    label: 'Narrowest first',
    compare: (a, b) => (a.dimensions?.width ?? 0) - (b.dimensions?.width ?? 0)
  },
  name: { label: 'Name, A to Z', compare: (a, b) => a.name.localeCompare(b.name) }
};

/**
 * Applies a sort without mutating the caller's array.
 *
 * 'relevance' deliberately returns the catalogue's own order, which already
 * puts featured pieces first — re-sorting it would throw away the ordering the
 * shops and the query established.
 */
export function sortProducts(products, key) {
  const compare = SORTS[key]?.compare;
  return compare ? [...products].sort(compare) : products;
}

/**
 * Everything one product can be matched on.
 *
 * `description` was missing, which made the search quietly worse than it
 * looked: a shopper searching "rattan" got nothing unless the word happened to
 * be in the product's name, even when the description was all about rattan.
 */
export function haystackFor(product) {
  return [
    product.name,
    product.store,
    product.category,
    product.style,
    product.color,
    product.description
  ].filter(Boolean).join(' ').toLowerCase();
}

export function matches(product, f) {
  // Every term must appear somewhere, so "rattan chair" finds a rattan dining
  // chair. Substring-matching the raw phrase would not: the words are almost
  // never adjacent in that order.
  const terms = f.search.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = terms.length ? haystackFor(product) : '';

  return (
    terms.every(term => haystack.includes(term)) &&
    (!f.category || product.category === f.category) &&
    (!f.store || product.storeId === f.store) &&
    // At the top of the range the label reads "No limit", so it has to mean
    // it. It used to still apply `width <= 240`, which hid every piece wider
    // than 240 cm permanently — including from the default, unfiltered view.
    // A 260 cm sofa could not be found by any combination of controls.
    (f.width >= NO_LIMIT || (product.dimensions?.width ?? 0) <= f.width) &&
    (!f.color || product.color === f.color) &&
    // Derived from the asset, like everywhere else — a product cannot satisfy
    // this filter by setting a flag.
    (!f.modelOnly || Boolean(product.modelGlb)) &&
    (!f.inStockOnly || Number(product.stock) > 0)
  );
}
