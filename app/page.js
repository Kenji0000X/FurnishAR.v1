import Link from 'next/link';
import { getCatalog } from '../lib/catalog.mjs';
import CatalogSection from './CatalogSection.js';

// The catalogue is a file the owner portal can write to, so pages are allowed
// to render again rather than being frozen at build time.
export const revalidate = 60;

export const metadata = {
  description:
    'Explore furniture from Mamburao stores, see it at true scale, and check your room before you buy.'
};

function Hero() {
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
        <dl className="hero-facts">
          <div><dt>3</dt><dd>Local stores</dd></div>
          <div><dt>1:1</dt><dd>True-scale preview</dd></div>
          <div><dt>±5%</dt><dd>Target scan margin</dd></div>
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

export default async function HomePage() {
  // Rendered on the server, so the full catalogue is in the HTML a crawler or a
  // shared link receives — the filters below hydrate on top of it rather than
  // being the only way to see a product.
  const { products } = await getCatalog();

  return (
    <section className="view active" aria-labelledby="hero-title">
      <Hero />
      <CatalogSection products={products} />
    </section>
  );
}
