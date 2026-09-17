import Link from 'next/link';

export const metadata = {
  title: 'Page not found'
};

/**
 * The 404.
 *
 * Next ships a bare "404 | This page could not be found" that renders without
 * the site's own header, footer or stylesheet — so the one moment a visitor is
 * already lost is also the moment the site looks broken and abandoned.
 *
 * The most likely way to arrive here is a product that a store removed or
 * unpublished, often from a link someone was sent. So the page leads with the
 * way back into the catalogue rather than an apology.
 */
export default function NotFound() {
  return (
    <section className="not-found">
      <p className="eyebrow">Error 404</p>
      <h1>This page isn&apos;t here.</h1>
      <p className="not-found-lede">
        The link may be old, or a store may have taken the piece down. Nothing is
        wrong with your connection.
      </p>

      <div className="not-found-actions">
        <Link className="button button-primary" href="/">Browse the catalog</Link>
        <Link className="button" href="/plan">Measure my space</Link>
      </div>

      <p className="not-found-note">
        Looking for a specific piece? Search the catalog — every published product
        from every approved store is in there.
      </p>
    </section>
  );
}
