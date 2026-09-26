'use client';

import { useEffect, useMemo, useState } from 'react';
import ProductCard from './ProductCard.js';
import PlaceholderCard from './PlaceholderCard.js';
import { placeholderSlots } from './model-state.js';
import { colorFor } from './format.js';
import { matches, sortProducts, SORTS, NO_LIMIT, EMPTY_FILTERS as EMPTY } from './catalog-filter.js';

/**
 * The grid and its filters.
 *
 * This is a client component so filtering stays instant, but its first render
 * happens on the server — the HTML already contains every card. Filtering is
 * an enhancement on top of a complete page, not the only route to the content.
 */
export default function CatalogSection({ products, source = 'supabase' }) {
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
    const params = new URLSearchParams(window.location.search);

    const wanted = params.get('category');
    if (wanted) {
      const known = products.some(product => product.category === wanted);
      if (known) setFilters(current => ({ ...current, category: wanted }));
    }

    /* ?q= is what the header's search box submits.
       Without this the field would be decoration: a search that navigates
       here and then shows the unfiltered grid is worse than no search at
       all, because it looks like it worked. Unlike ?category= this is not
       validated against the catalogue — an unmatched term should land on the
       honest "nothing matched" state, not be silently dropped. */
    const query = params.get('q');
    if (query) setFilters(current => ({ ...current, search: query }));
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

  /*
     Whether the filter disclosure is open.
     Starts closed so the server-rendered HTML is the same for everyone (an
     `open` that depended on the viewport would be a hydration mismatch), then
     opens itself on a wide screen where the panel sits beside the grid and
     costs nothing. Kept in sync if the window is resized across the
     breakpoint, so a rotated phone or a resized desktop stays sensible.
  */
  const [filtersOpen, setFiltersOpen] = useState(false);
  useEffect(() => {
    const wide = window.matchMedia('(min-width: 821px)');
    const apply = () => setFiltersOpen(wide.matches);
    apply();
    wide.addEventListener('change', apply);
    return () => wide.removeEventListener('change', apply);
  }, []);

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
  if (filters.inStockOnly) active.push({ key: 'stock', label: 'In stock', clear: { inStockOnly: false } });

  /*
    Nothing to show. No "0 pieces", no search, sort or filters for
    categories and stores that do not exist.

    A catalogue that could not be reached is not the same news as one with
    nothing in it yet, so it gets its own sentence and no placeholders.
    An empty one shows three placeholder cards, so the page still has the
    shape of the catalogue to come — see PlaceholderCard for what they are
    not. No store or admin links here: a shopper has nothing to do with them.
  */
  if (!products.length) {
    if (source === 'unavailable') {
      return (
        <section id="catalog" className="catalog-section catalog-empty" aria-labelledby="catalog-title">
          <h2 id="catalog-title" className="sr-only">Every piece</h2>
          <div className="catalog-empty-state" role="alert">
            <span className="catalog-empty-mark" aria-hidden="true">⬚</span>
            <p className="catalog-empty-title">The collection couldn’t be loaded right now.</p>
            <p className="catalog-empty-copy">Please try again in a moment.</p>
          </div>
        </section>
      );
    }
    return (
      <section id="catalog" className="catalog-section catalog-empty" aria-labelledby="catalog-title">
        <div className="section-heading">
          <div>
            <h2 id="catalog-title">Every piece</h2>
            <p className="catalog-empty-note">No 3D models have been uploaded yet.</p>
          </div>
        </div>
        <div className="product-grid placeholder-grid">
          {Array.from({ length: placeholderSlots(0) }, (_, index) => <PlaceholderCard key={index} />)}
        </div>
      </section>
    );
  }

  /* Fewer than three real pieces, and nothing narrowing them: the rest of the
     row is placeholders. Never while a filter or search is on — there the
     honest answer is the matching pieces, or "nothing matched". */
  const fill = active.length ? 0 : placeholderSlots(found.length);

  return (
    <section id="catalog" className="catalog-section" aria-labelledby="catalog-title">
      <div className="section-heading">
        <div>
          <h2 id="catalog-title">Every piece</h2>
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
        {/*
           Search lives outside the disclosure below, and above it.

           It went inside for one build, and on a phone that put the search
           field behind a "Filters" button — so the quickest way to find a
           chair was hidden behind the control for narrowing a list you could
           not see. Searching and filtering are different acts; only the
           second is worth collapsing.
        */}
        <label className="search-input catalog-search">
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            placeholder="Search furniture…"
            aria-label="Search furniture"
            value={filters.search}
            onChange={event => set({ search: event.target.value })}
          />
        </label>

        {/*
           A disclosure, not a sidebar, once the screen is narrow.

           On a phone the filter panel is ~690px tall, so it stood between the
           heading and the first piece of furniture: you landed on the
           catalogue and scrolled a whole screen of controls before seeing
           anything to buy. On a desktop, where it sits beside the grid rather
           than above it, it costs nothing and stays open.

           <details> rather than a hand-rolled panel because the disclosure
           behaviour — keyboard, screen reader, the open/closed state itself —
           is what the element is for. `open` is controlled so the desktop
           layout can keep it open while the summary is hidden.
        */}
        <details
          className="filters"
          open={filtersOpen}
          onToggle={event => setFiltersOpen(event.currentTarget.open)}
        >
          <summary className="filters-summary">
            <span>Refine your search</span>
            <span className="filters-count">
              {active.length ? `${active.length} on` : `${found.length} of ${products.length}`}
            </span>
          </summary>
          <div className="filter-heading">
            <h3>Refine your search</h3>
            <button className="clear-button" type="button" onClick={() => setFilters(EMPTY)}>
              Clear all
            </button>
          </div>

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

          {/* No "Pieces with a 3D model" toggle: every piece in the
              collection has one (isListable), so it would filter nothing. */}
          <fieldset className="filter-group toggle-group">
            <legend>Show only</legend>
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
        </details>

        <div className="product-grid" aria-live="polite">
          {found.length ? (
            // The first two cards are the first the grid shows: fetch their
            // posters straight away, the rest as they scroll into view.
            <>
              {found.map((product, index) => <ProductCard key={product.id} product={product} priority={index < 2} />)}
              {Array.from({ length: fill }, (_, index) => <PlaceholderCard key={`placeholder-${index}`} />)}
            </>
          ) : (
            <div className="no-results">
              <b>No furniture matches these filters.</b>
              <p>Try removing one of the filters above.</p>
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
