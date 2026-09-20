'use client';

import { useEffect, useRef } from 'react';

/**
 * Three promises that light up as you reach them.
 *
 * The reference stacks short claims and lets each one resolve from a washed
 * tint to full ink as it arrives — the page reads itself to you at the speed
 * you scroll. It is the cheapest possible progress indicator: you can see how
 * much of the argument is left without a bar telling you.
 *
 * Built on IntersectionObserver rather than a scroll handler, so the browser
 * does the geometry on its own thread and this component runs code only at
 * the four moments something actually crosses the line. The class it toggles
 * animates colour and opacity only — no layout, no reflow, nothing that could
 * make a phone stutter mid-scroll.
 *
 * Without JavaScript, or with reduced motion, every item renders in its
 * resolved state. The effect is an enhancement on a page that is already
 * completely readable, never the thing standing between someone and the text.
 */
export default function Promises({ items }) {
  const rootRef = useRef(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;

    const nodes = [...root.querySelectorAll('.promise')];

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const node of nodes) node.classList.add('is-lit');
      return undefined;
    }

    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          // Light on the way in, and stay lit. Re-dimming on the way back up
          // makes the page feel like it is forgetting what it told you.
          if (entry.isIntersecting) {
            entry.target.classList.add('is-lit');
            observer.unobserve(entry.target);
          }
        }
      },
      // Fires when the item reaches the comfortable reading band rather than
      // the very bottom edge, so it is already lit by the time it is read.
      { rootMargin: '-18% 0px -38% 0px' }
    );

    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="promise-list" ref={rootRef}>
      {items.map(item => (
        <article className="promise" key={item.title}>
          <h3>{item.title}</h3>
          <p>{item.body}</p>
        </article>
      ))}
    </div>
  );
}
