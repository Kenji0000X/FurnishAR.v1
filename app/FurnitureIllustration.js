import { colorFor, previewShape } from './format.js';

/**
 * The CSS-drawn piece of furniture. Every span is a surface the stylesheet
 * positions per shape, which is why they are all present regardless of shape —
 * `.furniture-illustration.chair .piece.top` and friends do the hiding.
 */
export default function FurnitureIllustration({ product, className = '' }) {
  return (
    <div
      className={`furniture-illustration ${previewShape(product)} ${className}`.trim()}
      style={{ '--piece': colorFor(product) }}
      aria-hidden="true"
    >
      <span className="piece back" />
      <span className="piece seat" />
      <span className="piece top" />
      <span className="piece leg leg-a" />
      <span className="piece leg leg-b" />
      <span className="piece leg leg-c" />
      <span className="piece leg leg-d" />
      <span className="piece side side-a" />
      <span className="piece side side-b" />
      <span className="piece shelf-line shelf-one" />
      <span className="piece shelf-line shelf-two" />
      <span className="piece shelf-line shelf-three" />
    </div>
  );
}
