'use client';

import { useEffect, useRef } from 'react';

/**
 * The small things drifting around the room.
 *
 * In the reference these are extra 3D props — olives, chillies, basil — one
 * per ingredient, orbiting the hero. Doing that literally here would mean
 * modelling half a dozen more objects and paying for them on every frame, to
 * decorate a page whose subject is already a room full of furniture.
 *
 * So they are DOM elements instead, drawn from the same measurement vocabulary
 * the product already uses: centimetre tags, a corner bracket, a scan
 * reticle. They say something true about the app — this is a thing that
 * measures rooms — where an orbiting olive would only say "3D".
 *
 * Motion is a single transform per element, written straight to the style in
 * one rAF-batched pass. No layout properties, no per-element listeners, and
 * nothing at all when the page is still or the visitor asked for less motion.
 */
/*
   Placed to stay OFF the copy.

   The headline occupies roughly the left 45% from 20% to 60% down, and the
   capsule rail the right edge at mid-height. Everything here lives outside
   those two rectangles, because a floating centimetre tag landing on top of
   the first word of the headline is not atmosphere — it is a defect, and it
   is exactly what the first pass shipped.
*/
const MOTES = [
  { className: 'mote mote-tag', depth: 0.9, x: 52, y: 17, label: '210 cm' },
  { className: 'mote mote-tag mote-tag-alt', depth: 1.5, x: 40, y: 82, label: '78 cm' },
  { className: 'mote mote-bracket', depth: 1.2, x: 82, y: 14 },
  { className: 'mote mote-bracket mote-bracket-flip', depth: 0.7, x: 62, y: 90 },
  { className: 'mote mote-dot', depth: 2.1, x: 46, y: 10 },
  { className: 'mote mote-dot', depth: 1.7, x: 92, y: 72 },
  { className: 'mote mote-dot', depth: 2.4, x: 33, y: 93 },
  { className: 'mote mote-ring', depth: 1.1, x: 72, y: 8 }
];

export default function HeroDecor() {
  const rootRef = useRef(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;

    const nodes = [...root.querySelectorAll('.mote')];
    const depths = nodes.map(node => Number(node.dataset.depth) || 1);

    let frame = 0;
    let pointerX = 0;
    let pointerY = 0;

    const paint = () => {
      frame = 0;
      const rect = root.getBoundingClientRect();
      // How far the stage has scrolled past, in viewport heights. Used as the
      // parallax clock so the motes keep drifting while the room travels.
      const scrolled = -rect.top / Math.max(window.innerHeight, 1);
      for (let i = 0; i < nodes.length; i += 1) {
        const depth = depths[i];
        const lift = scrolled * depth * 90;
        const drift = pointerX * depth * 14;
        const tilt = pointerY * depth * 10;
        nodes[i].style.transform = `translate3d(${drift}px, ${-lift + tilt}px, 0)`;
      }
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };

    const onPointer = event => {
      pointerX = (event.clientX / window.innerWidth) * 2 - 1;
      pointerY = (event.clientY / window.innerHeight) * 2 - 1;
      schedule();
    };

    // Only while the stage is on screen. Off screen this does nothing at all.
    let live = true;
    const visibility = new IntersectionObserver(entries => {
      live = entries.some(entry => entry.isIntersecting);
      if (live) schedule();
    });
    visibility.observe(root);

    const onScroll = () => { if (live) schedule(); };
    window.addEventListener('scroll', onScroll, { passive: true });
    // Pointer parallax is a mouse affordance; a touch device has no hover and
    // firing this on every touchmove would fight the scroll.
    const fine = window.matchMedia('(pointer: fine)').matches;
    if (fine) window.addEventListener('pointermove', onPointer, { passive: true });
    schedule();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      visibility.disconnect();
      window.removeEventListener('scroll', onScroll);
      if (fine) window.removeEventListener('pointermove', onPointer);
    };
  }, []);

  return (
    <div className="hero-decor" ref={rootRef} aria-hidden="true">
      {MOTES.map((mote, index) => (
        <span
          key={index}
          className={mote.className}
          data-depth={mote.depth}
          style={{ left: `${mote.x}%`, top: `${mote.y}%` }}
        >
          {mote.label}
        </span>
      ))}
    </div>
  );
}
