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
      <Portal initialProducts={products} />
    </section>
  );
}
