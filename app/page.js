import Link from 'next/link';
import { getCatalog, getStores } from '../lib/catalog.mjs';
import HeroStage from './HeroStage.js';
import Promises from './Promises.js';
import ProductThumb from './ProductThumb.js';
import CtaArrow from './CtaArrow.js';
import RevealObserver from './RevealObserver.js';

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
    key: 'size',
    title: 'Real sizes, not press photos.',
    body: `Every piece carries the width, depth and height its shop measured, and
           the planner places it at exactly that.`
  },
  {
    key: 'browser',
    title: 'No app, no appointment.',
    body: `It runs in the browser you already have. Point the camera at a wall or a
           doorway and read the span in centimetres.`
  },
  {
    key: 'local',
    title: 'The shops are down the road.',
    body: `Every piece is stocked in Mamburao. Check the fit here, then buy it from
           the shop itself.`
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

function Hero({ capsules }) {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-copy">
        <p className="eyebrow">Furniture, made certain</p>
        {/* Stacked, one word to a line, set as large as the viewport allows.
            The reference's headline is the page's whole structure; this is
            the same idea in the brand's own voice. */}
        {/* Two lines, never three: a hero headline is read at a glance. */}
        <h1 id="hero-title">
          <span>See it. Fit it.</span>
          <span className="hero-title-accent">Live with it.</span>
        </h1>
        <p className="hero-text">
          Stand furniture from Mamburao stores in your own room at true scale, and
          know it fits before you buy.
        </p>
        <div className="hero-actions">
          <Link className="capsule capsule-solid capsule-cta" href="/plan">
            Measure my space <CtaArrow />
          </Link>
          <Link className="capsule capsule-quiet" href="/collection">
            Browse the collection
          </Link>
        </div>
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

/**
 * The figures that used to sit inside the hero. A hero is one message and
 * one action; these are evidence for it, so they get their own band right
 * under it. Every number is counted from the live catalogue.
 */
function Facts({ facts }) {
  return (
    <section className="facts-band" aria-label="FurnishAR in numbers">
      <dl className="facts-grid">
        <div><dt>{facts.stores}</dt><dd>{facts.stores === 1 ? 'Local store' : 'Local stores'}</dd></div>
        <div><dt>{facts.arReady}</dt><dd>{facts.arReady === 1 ? 'Piece in AR' : 'Pieces in AR'}</dd></div>
        <div><dt>1:1</dt><dd>True scale</dd></div>
      </dl>
    </section>
  );
}

function Story() {
  return (
    <section className="story" aria-labelledby="story-title">
      <div className="story-copy reveal">
        <h2 id="story-title">Nothing arrives too big.</h2>
        <p>
          A sofa that will not turn the stair corner goes back on the truck.
          FurnishAR gives you the forty-second measurement that prevents it.
        </p>
        <Link className="capsule capsule-solid capsule-cta" href="/plan">
          Measure my space <CtaArrow />
        </Link>
      </div>
    </section>
  );
}

function PromiseSection({ showcase }) {
  return (
    <section className="promise-section" aria-labelledby="promise-title">
      <div className="promise-copy">
        <h2 id="promise-title" className="reveal">Three things this actually does.</h2>
        <Promises items={PROMISES} showcase={showcase} />
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
        <Hero capsules={capsulesFrom(products)} />
        <Facts facts={facts} />
        <Story />
        <PromiseSection showcase={products.find(product => product.thumbnail) || null} />
      </HeroStage>
      <RevealObserver />

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
