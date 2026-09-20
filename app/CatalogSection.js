'use client';

import { useEffect, useMemo, useState } from 'react';
import ProductCard from './ProductCard.js';
import { colorFor } from './format.js';
import { matches, sortProducts, SORTS, NO_LIMIT, EMPTY_FILTERS as EMPTY } from './catalog-filter.js';

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

  // A category can arrive in the URL: /?category=Chair#catalog.
  //
  // This is what makes the capsule rail in the hero honest. Without it those
  // are three beautiful buttons that scroll you to an unfiltered grid and let
  // you work out for yourself which of the pieces were the chairs — which is
  // worse than not offering the shortcut at all.
  //
  // Read after mount rather than during render: the server has no idea what
  // the query string is when this page is prerendered, so seeding the first
  // render from it is the classic hydration mismatch. Only a category the
  // catalogue actually has is honoured, so a stale or hand-edited link shows
  // everything instead of an empty grid.
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('category');
    if (!wanted) return;
    const known = products.some(product => product.category === wanted);
    if (known) setFilters(current => ({ ...current, category: wanted }));
  }, [products]);

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
  const [sort, setSort] = useState('relevance');

  // How many pieces the shops have actually modelled, shown on the filter so
  // a shopper can see what turning it on will cost them before they do.
  const withModels = useMemo(
    () => products.filter(product => product.modelGlb).length,
    [products]
  );

  const found = useMemo(
    () => sortProducts(products.filter(product => matches(product, filters)), sort),
    [products, filters, sort]
  );

  // Which controls are actually narrowing the results. Shown as removable
  // chips, because a filter you cannot see is a filter you cannot undo —
  // "no results" with a forgotten colour still selected is the most common
  // dead end in any catalogue.
  const active = [];
  if (filters.search) active.push({ key: 'search', label: `"${filters.search}"`, clear: { search: '' } });
  if (filters.category) active.push({ key: 'category', label: filters.category, clear: { category: '' } });
  if (filters.store) {
    const name = stores.find(s => s.slug === filters.store)?.name || filters.store;
    active.push({ key: 'store', label: name, clear: { store: '' } });
  }
  if (filters.color) active.push({ key: 'color', label: filters.color, clear: { color: '' } });
  if (filters.width < NO_LIMIT) {
    active.push({ key: 'width', label: `Up to ${filters.width} cm`, clear: { width: NO_LIMIT } });
  }
  if (filters.modelOnly) active.push({ key: 'model', label: 'Has a 3D model', clear: { modelOnly: false } });
  if (filters.inStockOnly) active.push({ key: 'stock', label: 'In stock', clear: { inStockOnly: false } });

  return (
    <section id="catalog" className="catalog-section" aria-labelledby="catalog-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Made nearby, chosen by you</p>
          <h2 id="catalog-title">Explore the collection</h2>
        </div>
        <div className="catalog-tools">
          <p className="result-count" aria-live="polite">
            {found.length} {found.length === 1 ? 'piece' : 'pieces'}
          </p>
          <label className="sort-control">
            <span>Sort</span>
            <select value={sort} onChange={event => setSort(event.target.value)}>
              {Object.entries(SORTS).map(([key, { label }]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {active.length > 0 && (
        <div className="active-filters">
          <span className="active-filters-label">Filtered by</span>
          <ul>
            {active.map(chip => (
              <li key={chip.key}>
                <button type="button" onClick={() => set(chip.clear)}>
                  {chip.label}
                  <span aria-hidden="true">×</span>
                  <span className="sr-only">, remove this filter</span>
                </button>
              </li>
            ))}
          </ul>
          <button className="clear-button" type="button" onClick={() => setFilters(EMPTY)}>
            Clear all
          </button>
        </div>
      )}

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
            {/*
               A <legend> labels its fieldset, not the controls inside it, so
               without this the select announced as "combo box, All furniture"
               with no clue what it filtered. The visible legend stays as the
               sighted label; this is the same word for a screen reader.
            */}
            <select
              aria-label="Filter by category"
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
            <select
              aria-label="Filter by store"
              value={filters.store}
              onChange={event => set({ store: event.target.value })}
            >
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

          <fieldset className="filter-group toggle-group">
            <legend>Show only</legend>
            <label className="filter-toggle">
              <input
                type="checkbox"
                checked={filters.modelOnly}
                onChange={event => set({ modelOnly: event.target.checked })}
              />
              <span>
                Pieces with a 3D model
                <small>{withModels} of {products.length}</small>
              </span>
            </label>
            <label className="filter-toggle">
              <input
                type="checkbox"
                checked={filters.inStockOnly}
                onChange={event => set({ inStockOnly: event.target.checked })}
              />
              <span>In stock now</span>
            </label>
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
              <p>
                {filters.modelOnly && withModels === 0
                  ? 'None of the pieces listed here have a 3D model yet.'
                  : 'Try removing one of the filters above.'}
              </p>
              <button className="button button-outline" type="button" onClick={() => setFilters(EMPTY)}>
                Clear all filters
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
