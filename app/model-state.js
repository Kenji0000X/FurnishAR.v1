/**
 * What this product actually has, and what the interface is therefore allowed
 * to claim about it.
 *
 * WHY THIS EXISTS
 * Before this file, every product in the catalogue drew the same CSS
 * silhouette — a rectangle-and-legs shape picked from a keyword like "chair"
 * or "shelf" — and every product was flagged `arReady: true`. So a piece with
 * a real scanned model and a piece with no model at all were pixel-identical
 * on the card, on the detail page, and in the AR badge. One of those two
 * products could be stood in your living room at true scale. The other could
 * not, and the interface said otherwise.
 *
 * That is not a styling problem. A shop's listing implying a 3D model it does
 * not have is the app making a promise on the shop's behalf that the shop
 * cannot keep, and the shopper finds out at the moment they point the camera.
 *
 * So representation is derived from the asset, never asserted alongside it.
 * There is exactly one function that decides, everything visual reads from it,
 * and a product cannot claim AR by setting a flag.
 */

/**
 * The four states a product's visual can be in. They are deliberately
 * distinguishable to the viewer — see §12 of the design brief: never silently
 * substitute one for another.
 */
export const MODEL_STATE = {
  /** A real uploaded .glb. Can be rendered, placed, and measured. */
  MODEL: 'model',
  /** No model, but a real photograph the shop uploaded. */
  IMAGE: 'image',
  /** Neither. The listing is text and dimensions only, and says so. */
  NONE: 'none'
};

/**
 * Reads the product's assets and reports what it genuinely has.
 *
 * Order matters: a model outranks a photograph, because the model is the thing
 * the whole product is for. `arReady` is deliberately NOT consulted — it is a
 * column a store row can set to true without uploading anything, which is
 * exactly how the catalogue came to claim AR for two products with no model.
 */
export function modelState(product) {
  if (product?.modelGlb) return MODEL_STATE.MODEL;
  if (product?.imageUrl) return MODEL_STATE.IMAGE;
  return MODEL_STATE.NONE;
}

/**
 * Whether this piece can genuinely be placed in a room at true scale.
 *
 * The planner needs a .glb. Nothing else qualifies, whatever the row says.
 */
export function canPlaceInSpace(product) {
  return modelState(product) === MODEL_STATE.MODEL;
}

/**
 * The thumbnail to show, which is always a render of THIS product's own model.
 *
 * The shop's own browser renders these from the exact .glb it uploaded
 * (app/portal/poster.js), so the picture on the card is the thing you get —
 * not a stock photo, not a generated lookalike, not another product's render. If there is
 * no thumbnail there is no picture, and the caller shows the empty state
 * rather than reaching for something that resembles the product.
 */
export function thumbnailFor(product) {
  return product?.thumbnail || null;
}

/**
 * How long after a model's upload its card may say "Preparing preview…".
 *
 * The poster is rendered in the owner's browser and uploaded straight after
 * the model (app/portal/ProductFormDialog.js): seconds, not hours. Inside
 * this window a missing poster really is being prepared. Past it, nothing is
 * — the model predates posters, or its poster failed — and saying
 * "Preparing preview…" would be a promise nobody is keeping.
 */
export const PREVIEW_GRACE_MS = 15 * 60 * 1000;

/**
 * The state of a product's catalogue picture:
 *   'ready'     — its poster, rendered from its own model, exists;
 *   'preparing' — a model was uploaded within PREVIEW_GRACE_MS and its
 *                 poster is not linked yet;
 *   'missing'   — no model, or a model with no poster past the grace window.
 */
export function previewState(product, now = Date.now()) {
  if (modelState(product) !== MODEL_STATE.MODEL) return 'missing';
  if (product.thumbnail) return 'ready';
  const uploaded = Date.parse(product.modelUploadedAt || '');
  return Number.isFinite(uploaded) && now - uploaded >= -60000 && now - uploaded < PREVIEW_GRACE_MS
    ? 'preparing' : 'missing';
}

/**
 * Whether a product may appear in the PUBLIC collection as a real card.
 *
 * Only when a shopper can see its 3D model: a real uploaded .glb AND its
 * catalogue picture (or that picture being made right now). A listing with no
 * model, or a model nobody can see on the card, is an incomplete record, not
 * a product to show — and a grey box above a name, a price and "View in my
 * space" reads as complete when it is not. It still exists: the shop edits it
 * in the portal (which says what is missing) and its own page still answers.
 * `arReady` is not consulted, for the reason modelState() gives.
 */
export function isListable(product, now = Date.now()) {
  return previewState(product, now) !== 'missing';
}

/**
 * How many empty-state cards the collection shows beside `realCount` real
 * pieces: enough to make three, so an empty or nearly empty catalogue still
 * shows the shape of the one to come. They are placeholders, not products —
 * never counted, linked, searched or stored — and they disappear as real
 * uploads take their places.
 */
export const PLACEHOLDER_SLOTS = 3;
export function placeholderSlots(realCount) {
  return Math.max(0, PLACEHOLDER_SLOTS - Math.max(0, Number(realCount) || 0));
}

/** Human wording for each state, used in badges and in the viewer's fallback. */
export const MODEL_STATE_LABEL = {
  [MODEL_STATE.MODEL]: '3D model',
  [MODEL_STATE.IMAGE]: 'Photo only',
  [MODEL_STATE.NONE]: 'No preview yet'
};
