import { modelState, MODEL_STATE } from './model-state.js';
import PosterImage from './PosterImage.js';

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
  const classes = `product-thumb ${className}`.trim();

  /*
    The poster: a small image rendered from THIS product's own model when the
    shop uploaded it (app/portal/poster.js). The card never loads the model
    itself — twenty cards are twenty small pictures, not twenty WebGL scenes
    and twenty downloads of files measured in megabytes. The model loads only
    on the product page, in the viewer, or in AR.
  */
  if (product.thumbnail) {
    return (
      <PosterImage
        className={classes}
        src={product.thumbnail}
        // A render, not a photograph: finishes can differ from the real piece,
        // and a screen-reader user should know which they are hearing about.
        alt={`${product.name}, rendered from its 3D model`}
        sizes={sizes}
        priority={priority}
      />
    );
  }

  /*
    No picture, for one of two different reasons, and the card says which:
    a model exists but has no catalogue preview yet (the shop can regenerate
    it; the model still works on the product page), or there is no model at
    all. Nothing here fetches the model to make up for the missing picture.
  */
  const hasModel = state === MODEL_STATE.MODEL;
  return (
    <span className={`${classes} product-thumb-empty`} role="img"
      aria-label={hasModel
        ? `${product.name}, 3D model available, no preview picture yet`
        : state === MODEL_STATE.IMAGE
          ? `${product.name}, no picture available`
          : `${product.name}, no 3D model uploaded yet`}
    >
      <span aria-hidden="true">⬚</span>
      <small aria-hidden="true">{hasModel ? '3D model available' : 'No 3D model yet'}</small>
    </span>
  );
}
