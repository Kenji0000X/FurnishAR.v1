import Link from 'next/link';
import { getCatalog, getStores } from '../lib/catalog.mjs';
import HeroStage from './HeroStage.js';
import Promises from './Promises.js';
import ProductThumb from './ProductThumb.js';

// The catalogue is a file the owner portal can write to, so pages are allowed
// to render again rather than being frozen at build time.
export const revalidate = 60;

export const metadata = {
  description:
    'Explore furniture from Mamburao stores, see it at true scale, and check your room before you buy.'
};

/**
 * The three claims that light up on the way past.
 *
 * Each one is a thing the software does, phrased as what it gets you. Nothing
 * here describes a feature that has to be built first.
 */
const PROMISES = [
  {
    title: 'Real sizes, not press photos.',
    body: `Every piece carries the width, depth and height its shop measured. The
           planner puts it in your room at exactly that, so what clears the door on
           screen clears it in the house.`
  },
  {
    title: 'No app, no appointment.',
    body: `It runs in the browser you already have. Point the camera at the wall,
           the doorway or the empty floor and read the span back in centimetres.`
  },
  {
    title: 'The shops are down the road.',
    body: `Everything listed is stocked by a store in Mamburao. You check the fit
           here and buy it from them — there is no cart, and no middleman.`
  }
];

/**
 * The capsule rail beside the headline.
 *
 * Built from what the catalogue actually contains, not from a written-down
 * list of categories. A rail of four beautiful pills pointing at three empty
 * filters is the single easiest way to make a shop look bigger than it is,
 * and the quickest way to lose someone who taps one.
 */
function capsulesFrom(products) {
  const byCategory = new Map();
  for (const product of products) {
    if (!product.category) continue;
    const seen = byCategory.get(product.category);
    if (!seen) {
      byCategory.set(product.category, { count: 1, sample: product });
      continue;
    }
    seen.count += 1;
    // Prefer a sample that actually has a render, so the rail shows real
    // furniture where the catalogue has any. A category whose pieces have no
    // models shows no picture rather than a stand-in for one.
    if (!seen.sample.thumbnail && product.thumbnail) seen.sample = product;
  }
  return [...byCategory]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 3)
    .map(([category, { count, sample }]) => ({ category, count, sample }));
}

function Hero({ facts, capsules }) {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-copy">
        <p className="eyebrow">Furniture, made certain</p>
        {/* Stacked, one word to a line, set as large as the viewport allows.
            The reference's headline is the page's whole structure; this is
            the same idea in the brand's own voice. */}
        <h1 id="hero-title">
          <span>See it.</span>
          <span>Fit it.</span>
          <span className="hero-title-accent">Live with it.</span>
        </h1>
        <p className="hero-text">
          Explore furniture from Mamburao stores, stand it in your own room at true
          scale, and know it fits before you buy.
        </p>
        <div className="hero-actions">
          <Link className="capsule capsule-solid" href="/plan">
            Measure my space <span aria-hidden="true">→</span>
          </Link>
          <Link className="capsule capsule-quiet" href="/collection">
            Browse the collection
          </Link>
        </div>
        <dl className="hero-facts">
          <div><dt>{facts.stores}</dt><dd>{facts.stores === 1 ? 'Local store' : 'Local stores'}</dd></div>
          <div><dt>{facts.arReady}</dt><dd>{facts.arReady === 1 ? 'Piece in AR' : 'Pieces in AR'}</dd></div>
          <div><dt>1:1</dt><dd>True scale</dd></div>
        </dl>
      </div>

      {/* The rail. Each capsule is a real filter over a real category, with
          the count it actually holds. */}
      {capsules.length > 0 && (
        <nav className="capsule-rail" aria-label="Browse by category">
          {capsules.map(({ category, count, sample }) => (
            <Link
              className="capsule capsule-card"
              key={category}
              href={`/collection?category=${encodeURIComponent(category)}`}
            >
              <span className="capsule-thumb" aria-hidden="true">
                <ProductThumb product={sample} sizes="56px" />
              </span>
              <span className="capsule-label">
                <b>{category}</b>
                <small>{count} {count === 1 ? 'piece' : 'pieces'}</small>
              </span>
            </Link>
          ))}
        </nav>
      )}
    </section>
  );
}

function Story() {
  return (
    <section className="story" aria-labelledby="story-title">
      <div className="story-copy">
        <p className="eyebrow">Born from one bad delivery day</p>
        <h2 id="story-title">Nothing arrives too big.</h2>
        <p>
          A sofa that does not turn the corner of the stairs goes back on the truck,
          and everybody loses — the family that waited three weeks for it, and the
          shop that has to eat the trip. The measurement that would have prevented
          it takes about forty seconds.
        </p>
        <p>
          FurnishAR is that forty seconds, handed to the shopper before the order
          instead of to the driver after it.
        </p>
        <Link className="capsule capsule-solid" href="/plan">
          Try the planner <span aria-hidden="true">→</span>
        </Link>
      </div>
    </section>
  );
}

function PromiseSection() {
  return (
    <section className="promise-section" aria-labelledby="promise-title">
      <div className="promise-copy">
        <p className="eyebrow">What you get</p>
        <h2 id="promise-title">Three things this actually does.</h2>
        <Promises items={PROMISES} />
      </div>
    </section>
  );
}

export default async function HomePage() {
  // Rendered on the server, so the full catalogue is in the HTML a crawler or a
  // shared link receives — the filters below hydrate on top of it rather than
  // being the only way to see a product.
  const [{ products }, stores] = await Promise.all([getCatalog(), getStores()]);

  const facts = {
    stores: Object.keys(stores).length,
    arReady: products.filter(product => product.arReady).length
  };

  return (
    <section className="view active">
      {/* The room is pinned behind these three, and travels as they scroll. */}
      <HeroStage>
        <Hero facts={facts} capsules={capsulesFrom(products)} />
        <Story />
        <PromiseSection />
      </HeroStage>

      {/*
          The page ends here.

          It used to keep going — a sliding band of pieces, the whole
          catalogue grid, the FAQ and a pitch to shop owners — so the front
          page was four pages wearing one URL. Nothing below the three claims
          was ever the reason somebody arrived, and each of those sections is
          now a route of its own: /collection, /faq, and the store pitch at
          the top of /portal.
      */}
    </section>
  );
}
