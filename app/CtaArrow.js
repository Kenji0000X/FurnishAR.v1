import { ArrowUpRight } from '@phosphor-icons/react/dist/ssr';

/**
 * The arrow a primary call to action ends with.
 *
 * It sits in a circle of its own, flush with the button's inner edge, so it
 * reads as part of the control rather than a character after the label; on
 * hover it nudges up and right (CSS, .capsule-cta:hover). Decorative: the
 * button's own text is the accessible name.
 */
export default function CtaArrow() {
  return (
    <span className="cta-arrow" aria-hidden="true">
      <ArrowUpRight size={16} weight="bold" />
    </span>
  );
}
