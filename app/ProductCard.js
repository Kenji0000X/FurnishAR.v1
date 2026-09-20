import Link from 'next/link';
import { peso, dimensionLabel } from './format.js';
import { modelState, MODEL_STATE } from './model-state.js';
import ProductThumb from './ProductThumb.js';

/**
 * A piece in the catalogue.
 *
 * Answers the five questions a furniture card has to answer before a shopper
 * will click it: what is it, how much, who sells it, how big is it, and can I
 * stand it in my room. In that order, because that is the order they are asked
 * in.
 *
 * WHAT CHANGED AND WHY IT MATTERED
 * This used to render a CSS-drawn silhouette — a coloured rectangle with legs,
 * chosen from a keyword like "chair" — for every product, whether or not the
 * shop had uploaded anything. So the one piece in the catalogue with a real
 * scanned model looked exactly like the two with no model at all, and all
 * three carried an AR badge. The picture is now a render of the product's own
 * .glb (see scripts/render-thumbnails.mjs) or it is honestly absent. There is
 * no drawing that stands in for a model, because a drawing that stands in for
 * a model is a claim that there is one.
 */
export default function ProductCard({ product }) {
  const href = `/furniture/${product.slug || product.id}`;
  const state = modelState(product);
  const hasModel = state === MODEL_STATE.MODEL;

  return (
    <article className="product-card">
      <Link className="product-media" href={href} aria-label={`View ${product.name}`}>
        <ProductThumb product={product} sizes="(max-width: 700px) 45vw, 300px" />

        {/* One badge, and only when it is true. Text, not colour alone. */}
        {hasModel && (
          <span className="model-badge">
            <i aria-hidden="true" />
            3D
          </span>
        )}
      </Link>

      <div className="product-info">
        <h3 className="product-name">
          {/* The whole name is the target: a 24px arrow is a small thing to
              hit on a phone, and WCAG 2.2 wants the larger one. */}
          <Link href={href}>{product.name}</Link>
        </h3>
        <p className="product-store">{product.store}</p>

        <p className="product-price">{peso(product.price)}</p>
        <p className="product-dimension">{dimensionLabel(product.dimensions)}</p>

        {/*
          Offered only when the planner can actually honour it. A "View in
          space" button on a product with no model is a button that takes you
          to an empty planner and makes you work out why.
        */}
        {hasModel ? (
          <Link
            className="product-action"
            href={`/plan?product=${product.slug || product.id}&ar=1`}
          >
            View in my space <span aria-hidden="true">→</span>
          </Link>
        ) : (
          <span className="product-action is-unavailable">
            Not available in AR
          </span>
        )}
      </div>
    </article>
  );
}
