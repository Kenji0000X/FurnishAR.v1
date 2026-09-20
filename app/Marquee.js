'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import FurnitureIllustration from './FurnitureIllustration.js';
import { peso } from './format.js';

/**
 * The band of pieces that slides past.
 *
 * The reference runs an endless strip of photographs under its headline. The
 * strip here is the real catalogue — the same pieces, the same prices, the
 * same links as the grid further down — because a decorative strip of stock
 * furniture on a page whose entire promise is "these are the shops near you"
 * would be a lie told in CSS.
 *
 * HOW IT LOOPS
 * The list is rendered twice and the track is translated by exactly half its
 * width. At the halfway point the second copy is pixel-identical to where the
 * first started, so resetting to zero is invisible and there is no jump, no
 * clone bookkeeping, and no measuring on every frame.
 *
 * WHY NOT A CSS ANIMATION
 * Because it has to stop. A strip that keeps moving under the pointer is a
 * strip you cannot click, and one that keeps moving when focused is one a
 * keyboard cannot use. Both need a real pause, and pausing a CSS animation
 * mid-flight and resuming it without a jump is more code than the loop below.
 * It is also free when off screen, which a CSS animation is not.
 */
export default function Marquee({ products }) {
  const trackRef = useRef(null);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;

    let offset = 0;
    let frame = 0;
    let last = 0;
    let paused = false;
    let visible = false;

    const step = now => {
      frame = 0;
      const delta = last ? Math.min(now - last, 50) : 16;
      last = now;

      if (!paused) {
        // Half the track is one full copy of the list.
        const span = track.scrollWidth / 2;
        if (span > 0) {
          offset = (offset + (delta * 0.024)) % span;
          track.style.transform = `translate3d(${-offset}px, 0, 0)`;
        }
      }
      if (visible) schedule();
    };

    const schedule = () => {
      if (!frame && visible) frame = requestAnimationFrame(step);
    };

    const observer = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting);
      if (visible) {
        last = 0;
        schedule();
      } else if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    });
    observer.observe(track);

    const hold = () => { paused = true; };
    const release = () => { paused = false; last = 0; };

    track.addEventListener('pointerenter', hold);
    track.addEventListener('pointerleave', release);
    // Focus is the keyboard's version of hover: tabbing into a link inside a
    // moving strip must stop the strip, or the thing you just focused slides
    // out from under you.
    track.addEventListener('focusin', hold);
    track.addEventListener('focusout', release);

    const onVisibility = () => {
      if (document.hidden && frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      } else {
        last = 0;
        schedule();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      track.removeEventListener('pointerenter', hold);
      track.removeEventListener('pointerleave', release);
      track.removeEventListener('focusin', hold);
      track.removeEventListener('focusout', release);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [products.length]);

  if (!products.length) return null;

  // Twice through, so the loop has something to land on. The duplicate is
  // scenery: it carries the same links, so it is hidden from assistive tech
  // and taken out of the tab order rather than read out a second time.
  const copies = [
    { key: 'a', hidden: false },
    { key: 'b', hidden: true }
  ];

  return (
    <section className="marquee-section" aria-labelledby="marquee-title">
      <div className="marquee-head">
        <p className="eyebrow">In the shops right now</p>
        <h2 id="marquee-title">Measure it. Place it. Live with it.</h2>
      </div>

      <div className="marquee" role="group" aria-label="Pieces from the catalogue">
        <div className="marquee-track" ref={trackRef}>
          {copies.map(copy =>
            products.map(product => {
              const href = `/furniture/${product.slug || product.id}`;
              const card = (
                <figure className="marquee-card" key={`${copy.key}-${product.id}`}>
                  <div className="marquee-art">
                    <FurnitureIllustration product={product} />
                  </div>
                  <figcaption>
                    <b>{product.name}</b>
                    <span>{peso(product.price)}</span>
                  </figcaption>
                </figure>
              );
              return copy.hidden ? (
                <div aria-hidden="true" key={`${copy.key}-${product.id}`}>{card}</div>
              ) : (
                <Link className="marquee-link" href={href} key={`${copy.key}-${product.id}`}>
                  {card}
                </Link>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}
