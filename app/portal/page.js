import { getCatalog } from '../../lib/catalog.mjs';
import Portal from './Portal.js';

export const metadata = {
  title: 'Store owner portal',
  description: 'Sign in to keep your store listings and 3D models up to date on FurnishAR.',
  // Nothing here should ever be indexed or previewed.
  robots: { index: false, follow: false }
};

export default async function PortalPage() {
  // Only used by the demo backend, which has no per-store endpoint: the
  // owner's rows are filtered out of this list. A Supabase deployment reads
  // the store's own inventory, drafts included, from the database.
  const { products } = await getCatalog();

  return (
    <section className="view admin-view active" aria-labelledby="portal-title">
      <section className="admin-intro">
        <p className="eyebrow">For local partners</p>
        <h1 id="portal-title">Store owner portal</h1>
        <p>Keep the catalog current so shoppers always see available, accurate furniture.</p>
      </section>
      <Portal initialProducts={products} />
    </section>
  );
}
