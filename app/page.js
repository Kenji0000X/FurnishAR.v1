import Link from 'next/link';
import { getCatalog, getStores } from '../lib/catalog.mjs';
import CatalogSection from './CatalogSection.js';
import Faq from './Faq.js';

// The catalogue is a file the owner portal can write to, so pages are allowed
// to render again rather than being frozen at build time.
export const revalidate = 60;

export const metadata = {
  description:
    'Explore furniture from Mamburao stores, see it at true scale, and check your room before you buy.'
};

/**
 * The three steps, at 01/02/03.
 *
 * This is the same numbering the planner already uses on its own cards, moved
 * up to the page where someone decides whether to start. Each step links to
 * the route that actually performs it — none of them is a label for something
 * that has to be built later.
 */
const STEPS = [
  {
    n: '01',
    title: 'Find the piece',
    body: `Browse what the shops in Mamburao have in stock, filtered by room, by colour,
           or by the widest thing that will fit.`,
    href: '#catalog',
    cta: 'Open the collection'
  },
  {
    n: '02',
    title: 'Measure the space',
    body: `Point your camera at the doorway, the wall, or the empty floor. The planner
           reads the surface and gives you the span in centimetres.`,
    href: '/plan',
    cta: 'Start the planner'
  },
  {
    n: '03',
    title: 'Stand it in the room',
    body: `The piece is placed at its real size — not a preview scaled to look good —
           so what clears the door on screen clears it in the house.`,
    href: '/plan',
    cta: 'Place a piece'
  }
];

function Hero({ facts }) {
  return (
    <section className="hero">
      <div className="hero-copy">
        <p className="eyebrow">Furniture, made certain</p>
        <h1 id="hero-title">Find the piece that fits <em>your life.</em></h1>
        <p className="hero-text">
          Explore furniture from Mamburao stores, see it at true scale, and check your room
          before you buy.
        </p>
        <div className="hero-actions">
          <a className="button button-primary" href="#catalog">
            Browse furniture <span aria-hidden="true">→</span>
          </a>
          <Link className="text-button" href="/plan">
            <span className="play-icon" aria-hidden="true">▶</span> How it works
          </Link>
        </div>
        {/*
          Counted from the catalogue that is being rendered on this very page.

          Two of these three used to be typed in by hand, and one of them —
          "3 local stores" — was a number nobody had checked since the day it
          was written. A figure in a hero is a claim; deriving it is the only
          way it stays true after the next shop is approved.
        */}
        <dl className="hero-facts">
          <div><dt>{facts.stores}</dt><dd>{facts.stores === 1 ? 'Local store' : 'Local stores'}</dd></div>
          <div><dt>{facts.arReady}</dt><dd>{facts.arReady === 1 ? 'Piece in AR' : 'Pieces in AR'}</dd></div>
          <div><dt>1:1</dt><dd>True-scale preview</dd></div>
        </dl>
      </div>
      <div
        className="hero-room"
        aria-label="Illustration of an airy living room with a sofa, chair, table, and plant"
      >
        <span className="sun-glow" /><span className="window window-one" /><span className="window window-two" />
        <span className="wall-art art-one" /><span className="wall-art art-two" />
        <span className="room-sofa"><i /><b /><b /></span>
        <span className="room-chair"><i /></span>
        <span className="room-table" />
        <span className="room-plant"><i /><i /><i /><b /></span>
        <span className="room-rug" />
        <span className="measure-tag tag-sofa">210 cm</span>
        <span className="measure-tag tag-chair">78 cm</span>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section className="band band-deep" aria-labelledby="how-title">
      <div className="band-inner">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Three steps, one afternoon</p>
            <h2 id="how-title">How FurnishAR works.</h2>
          </div>
        </div>

        <ol className="step-list">
          {STEPS.map(step => (
            <li className="step-item" key={step.n}>
              <span className="step-number">{step.n}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
              {step.href.startsWith('#') ? (
                <a className="step-link" href={step.href}>
                  {step.cta} <span aria-hidden="true">→</span>
                </a>
              ) : (
                <Link className="step-link" href={step.href}>
                  {step.cta} <span aria-hidden="true">→</span>
                </Link>
              )}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function ClosingCta() {
  return (
    <section className="band band-deep band-cta" aria-labelledby="cta-title">
      <div className="band-inner">
        <p className="eyebrow">For the shops</p>
        <h2 id="cta-title">Sell the piece, not the guesswork.</h2>
        <p className="band-text">
          List your furniture with its real dimensions and a 3D model, and every shopper
          who finds it can check it against their own room first.
        </p>
        <div className="band-actions">
          <Link className="button button-primary" href="/portal">
            Open the store portal <span aria-hidden="true">→</span>
          </Link>
          <Link className="button button-outline" href="/plan">
            Try the planner
          </Link>
        </div>
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
    <section className="view active" aria-labelledby="hero-title">
      <Hero facts={facts} />
      <HowItWorks />
      <CatalogSection products={products} />
      <Faq />
      <ClosingCta />
    </section>
  );
}
