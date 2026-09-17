/**
 * Shown while a route segment's data is still on the way.
 *
 * The .skeleton-* rules already existed in the stylesheet, documented as
 * "a skeleton in the shape of the real card, so the layout never jumps" — but
 * nothing in the app ever rendered them, so the CSS was dead and every
 * navigation showed a blank page instead. This is the markup they were
 * written for.
 *
 * Six cards because that is roughly one screen of grid on a laptop; the point
 * is to hold the shape of the page, not to guess the result count.
 *
 * `aria-hidden` with a single polite status message: announcing nine
 * individual placeholder shapes tells a screen-reader user nothing, and
 * "Loading" tells them everything.
 */
export default function Loading() {
  return (
    <section className="catalog-section" aria-busy="true">
      <p className="sr-only" role="status">Loading furniture…</p>
      <div className="product-grid" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => (
          <div className="skeleton-card" key={index}>
            <div className="skeleton-image" />
            <div className="skeleton-info">
              <div className="skeleton-line is-title" />
              <div className="skeleton-line" />
              <div className="skeleton-line is-short" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
