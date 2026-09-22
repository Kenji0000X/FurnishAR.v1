import Link from 'next/link';
import { getCatalog } from '../../lib/catalog.mjs';
import Portal from './Portal.js';

// The catalogue is a file the owner portal can write to, so pages are allowed
// to render again rather than being frozen at build time.
export const revalidate = 60;

export const metadata = {
  title: 'Store owner portal',
  description: 'Sign in to keep your store listings and 3D models up to date on FurnishAR.',
  // Nothing here should ever be indexed or previewed.
  robots: { index: false, follow: false }
};

export default async function PortalPage() {
  // There is no per-store endpoint, so an owner's rows are filtered out of
  // this list.
  const { products } = await getCatalog();

  return (
    <section className="view admin-view active" aria-labelledby="portal-title">
      <section className="admin-intro">
        <p className="eyebrow">For local partners</p>
        <h1 id="portal-title">Store owner portal</h1>
        <p>Keep the catalog current so shoppers always see available, accurate furniture.</p>
      </section>

      {/*
          The pitch that used to close the home page.

          It was addressed to shop owners and sat at the bottom of a page
          written for shoppers, after the whole catalogue — the wrong audience
          at the wrong moment. Here it greets the person who followed "For
          stores" and is deciding whether to sign up.
      */}
      <section className="portal-pitch">
        <div>
          <p className="eyebrow">For the shops</p>
          <h2>Sell the piece, not the guesswork.</h2>
          <p>
            List your furniture with its real dimensions and a 3D model, and every
            shopper who finds it can check it against their own room first.
          </p>
        </div>
        <Link className="capsule capsule-solid" href="#apply">
          Apply to list <span aria-hidden="true">→</span>
        </Link>
      </section>
      <Portal initialProducts={products} />
    </section>
  );
}
