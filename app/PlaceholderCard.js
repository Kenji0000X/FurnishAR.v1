import { Cube } from '@phosphor-icons/react/dist/ssr';

/**
 * An empty slot in the collection, standing where a real piece will be.
 *
 * NOT A PRODUCT. It has no name, store, price, dimensions, badge or AR
 * action, links nowhere, is never counted as a piece, and is never stored:
 * it is drawn from the number of real pieces (placeholderSlots in
 * model-state.js) and nothing else, so a shop's first real upload takes its
 * place on the next render.
 *
 * Hidden from assistive technology: three identical "No 3D model yet" would
 * be read out three times. The section's own sentence says it once.
 */
export default function PlaceholderCard() {
  return (
    <div className="product-card placeholder-card" aria-hidden="true">
      <div className="product-media placeholder-media">
        <Cube className="placeholder-icon" size={24} weight="light" />
        <p className="placeholder-title">No 3D model yet</p>
        <p className="placeholder-copy">Uploaded furniture will appear here.</p>
      </div>
    </div>
  );
}
