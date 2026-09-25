import { getCatalog } from '../../lib/catalog.mjs';
import CatalogSection from '../CatalogSection.js';
import Marquee from '../Marquee.js';

// Rendered again at most once a minute, and at once when a store or admin
// changes the catalogue (revalidateTag('catalog') in app/api/sb).
export const revalidate = 60;

export const metadata = {
  title: 'The collection',
  description:
    'Every piece listed by a Mamburao store, with the width, depth and height its shop measured.'
};

/**
 * The catalogue, on its own route.
 *
 * It used to be a section of the home page reached by an anchor, which made
 * three things awkward at once: the home page never ended, "Collection" in the
 * navigation was a scroll rather than a destination, and a shopper who wanted
 * to send someone the grid could only send them the whole front page.
 *
 * As a route it can be linked, bookmarked, shared and crawled, and the
 * category shortcuts in the hero now point somewhere rather than scrolling.
 */
export default async function CollectionPage() {
  const { products, source } = await getCatalog();

  return (
    <section className="view active">
      <section className="page-intro">
        <p className="eyebrow">Made nearby, chosen for you</p>
        <h1>The collection.</h1>
        <p>
          Every piece here is stocked by a store in Mamburao and carries the
          dimensions that store measured. Check one against your own room before
          you go and look at it.
        </p>
      </section>

      <Marquee products={products} />
      <CatalogSection products={products} source={source} />
    </section>
  );
}
