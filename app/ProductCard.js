import Link from 'next/link';
import FurnitureIllustration from './FurnitureIllustration.js';
import { peso, dimensionLabel } from './format.js';

/**
 * A piece in the grid.
 *
 * The arrow used to open a JS dialog, which meant a piece of furniture had no
 * URL of its own — nothing to send a friend, nothing for a search engine to
 * index. It is a link to a real page now. That is the main thing the shops get
 * out of this migration.
 */
export default function ProductCard({ product }) {
  const href = `/furniture/${product.slug || product.id}`;
  return (
    <article className="product-card">
      <div className="product-image">
        <FurnitureIllustration product={product} />
        {product.arReady && <span className="ar-badge">AR</span>}
        <Link className="view-button" href={href} aria-label={`View ${product.name}`}>
          →
        </Link>
      </div>
      <div className="product-info">
        <p className="product-store">{product.store}</p>
        <h3 className="product-name">
          {/* The whole name is the link target: a 24px arrow is a small thing
              to hit on a phone, and WCAG 2.2 wants the larger target. */}
          <Link href={href}>{product.name}</Link>
        </h3>
        <div className="product-meta">
          <span className="product-price">{peso(product.price)}</span>
          <span className="product-dimension">{dimensionLabel(product.dimensions)}</span>
        </div>
      </div>
    </article>
  );
}
