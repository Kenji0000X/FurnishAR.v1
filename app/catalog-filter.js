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

export const EMPTY_FILTERS = { search: '', category: '', store: '', width: NO_LIMIT, color: '' };

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
    (!f.color || product.color === f.color)
  );
}
