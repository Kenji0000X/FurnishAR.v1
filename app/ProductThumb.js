import { modelState, MODEL_STATE } from './model-state.js';

/**
 * A product's picture, wherever one is shown.
 *
 * One component so the rule lives in one place: the image is a render of THIS
 * product's own uploaded model, or there is no image. Every surface that shows
 * a product — the catalogue card, the home-page strip, the category rail —
 * goes through here, so none of them can quietly grow its own fallback.
 *
 * The thing this replaced was a CSS-drawn silhouette: a coloured rectangle
 * with legs, picked from a keyword. It rendered identically for a piece with a
 * real scanned model and a piece with nothing uploaded, which is how the
 * catalogue came to show three products that all looked equally placeable when
 * only one was.
 *
 * `size` is a hint for the browser's lazy loading and nothing else; the CSS
 * decides the real dimensions.
 */
export default function ProductThumb({ product, className = '', sizes, priority = false }) {
  const state = modelState(product);

  if (product.thumbnail) {
    return (
      <img
        className={`product-thumb ${className}`.trim()}
        src={product.thumbnail}
        /*
          Described as the product, because it IS the product — the render
          comes from the file the shop uploaded. Saying "3D model" in the alt
          text matters: a screen-reader user should know this is a render and
          not a photograph of the physical item, because the two can differ in
          finish.
        */
        alt={`${product.name}, rendered from its 3D model`}
        width="900"
        height="900"
        sizes={sizes}
        loading={priority ? 'eager' : 'lazy'}
        decoding="async"
      />
    );
  }

  /*
    No picture. Which of the two reasons is shown, because they mean
    different things to a shop owner looking at their own listing: "nobody has
    uploaded a model" is a thing they can fix, and it is not the same as a
    model that failed to render.
  */
  return (
    <span className={`product-thumb product-thumb-empty ${className}`.trim()} role="img"
      aria-label={
        state === MODEL_STATE.IMAGE
          ? `${product.name}, no picture available`
          : `${product.name}, no 3D model uploaded yet`
      }
    >
      <span aria-hidden="true">⬚</span>
      <small aria-hidden="true">No 3D model yet</small>
    </span>
  );
}
