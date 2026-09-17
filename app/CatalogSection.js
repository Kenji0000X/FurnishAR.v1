'use client';

import { useMemo, useState } from 'react';
import ProductCard from './ProductCard.js';
import { colorFor } from './format.js';
import { matches, NO_LIMIT, EMPTY_FILTERS as EMPTY } from './catalog-filter.js';

/**
 * The grid and its filters.
 *
 * This is a client component so filtering stays instant, but its first render
 * happens on the server — the HTML already contains every card. Filtering is
 * an enhancement on top of a complete page, not the only route to the content.
 */
export default function CatalogSection({ products }) {
  const [filters, setFilters] = useState(EMPTY);
  const set = patch => setFilters(current => ({ ...current, ...patch }));

  const colors = useMemo(
    () => [...new Set(products.map(product => product.color))],
    [products]
  );

  // Derived from what is actually in the catalogue, not from a hardcoded list.
  //
  // The store list used to be three names written into this file. Approving a
  // fourth store in the admin console published its products but left it out
  // of the filter, so its pieces could not be narrowed to — and a category
  // outside the fixed five was equally unreachable. Anything the catalogue
  // contains is now offered, and anything it does not is not.
  const stores = useMemo(() => {
    const seen = new Map();
    for (const product of products) {
      if (product.storeId && !seen.has(product.storeId)) seen.set(product.storeId, product.store);
    }
    return [...seen].map(([slug, name]) => ({ slug, name: name || slug }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [products]);

  const categories = useMemo(
    () => [...new Set(products.map(product => product.category).filter(Boolean))].sort(),
    [products]
  );
  const found = useMemo(
    () => products.filter(product => matches(product, filters)),
    [products, filters]
  );

  return (
    <section id="catalog" className="catalog-section" aria-labelledby="catalog-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Made nearby, chosen by you</p>
          <h2 id="catalog-title">Explore the collection</h2>
        </div>
        <p className="result-count" aria-live="polite">
          {found.length} {found.length === 1 ? 'piece' : 'pieces'} to explore
        </p>
      </div>

      <div className="catalog-layout">
        <aside className="filters" aria-label="Filter furniture">
          <div className="filter-heading">
            <h3>Refine your search</h3>
            <button className="clear-button" type="button" onClick={() => setFilters(EMPTY)}>
              Clear all
            </button>
          </div>

          <label className="search-input">
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              placeholder="Search furniture"
              aria-label="Search furniture"
              value={filters.search}
              onChange={event => set({ search: event.target.value })}
            />
          </label>

          <fieldset className="filter-group">
            <legend>Category</legend>
            <select
              value={filters.category}
              onChange={event => set({ category: event.target.value })}
            >
              <option value="">All furniture</option>
              {categories.map(category => (
                <option key={category}>{category}</option>
              ))}
            </select>
          </fieldset>

          <fieldset className="filter-group">
            <legend>Store</legend>
            <select value={filters.store} onChange={event => set({ store: event.target.value })}>
              <option value="">All local stores</option>
              {stores.map(store => (
                <option key={store.slug} value={store.slug}>
                  {store.name}
                </option>
              ))}
            </select>
          </fieldset>

          <fieldset className="filter-group range-group">
            <legend>
              Maximum width{' '}
              <output>{filters.width >= NO_LIMIT ? 'No limit' : `${filters.width} cm`}</output>
            </legend>
            <input
              type="range"
              min="70"
              max={NO_LIMIT}
              value={filters.width}
              aria-label="Maximum width in centimetres"
              onChange={event => set({ width: Number(event.target.value) })}
            />
            <div><span>70 cm</span><span>240 cm+</span></div>
          </fieldset>

          <fieldset className="filter-group color-group">
            <legend>Colour</legend>
            <div className="color-options">
              {colors.map(color => (
                <button
                  key={color}
                  type="button"
                  className={`color-option${filters.color === color ? ' active' : ''}`}
                  style={{ background: colorFor({ color }) }}
                  aria-label={`Filter by ${color}`}
                  aria-pressed={filters.color === color}
                  // Tapping the active colour clears it, so a filter set by
                  // accident does not need a trip to "Clear all".
                  onClick={() => set({ color: filters.color === color ? '' : color })}
                />
              ))}
            </div>
          </fieldset>
        </aside>

        <div className="product-grid" aria-live="polite">
          {found.length ? (
            found.map(product => <ProductCard key={product.id} product={product} />)
          ) : (
            <div className="no-results">
              <b>No furniture matches these filters.</b>
              <br />
              <small>Try widening your search or clearing a filter.</small>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
