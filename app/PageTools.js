'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * The floating controls in the bottom corner: back to top, and contact.
 *
 * Both are hidden on /plan. The planner puts its own AR controls in that
 * corner and positions them in real centimetres, so a floating button parked
 * on top of them is not a small cosmetic clash — it covers the control someone
 * is trying to aim with a camera.
 *
 * Back to top only appears once there is a top to go back to, which is the
 * difference between a useful affordance and a button that scrolls a
 * one-screen page by nothing.
 */
export default function PageTools() {
  const pathname = usePathname();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      setScrolled(window.scrollY > window.innerHeight * 0.6);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
    };
  }, []);

  if (pathname.startsWith('/plan')) return null;

  function toTop() {
    // `behavior: 'smooth'` is requested, but html{scroll-behavior:smooth} plus
    // the reduced-motion media query in the stylesheet already governs this;
    // browsers honour the user's setting over the argument.
    window.scrollTo({ top: 0, behavior: 'smooth' });
    // Scrolling alone leaves focus where it was, so the next Tab continues
    // from the footer. Moving focus to the top makes the control mean the
    // same thing for a keyboard as it does for a mouse.
    document.getElementById('main')?.focus({ preventScroll: true });
  }

  return (
    <div className="page-tools">
      <a
        className="page-tool contact-float"
        href="mailto:hello@furnishar.ph?subject=FurnishAR%20enquiry"
        aria-label="Email FurnishAR"
        title="Email hello@furnishar.ph"
      >
        <span aria-hidden="true">✉</span>
      </a>
      <button
        className={`page-tool to-top${scrolled ? ' is-shown' : ''}`}
        type="button"
        onClick={toTop}
        // Hidden from the tab order while off-screen, so it is not a focus
        // stop that scrolls the page for someone who cannot see it yet.
        tabIndex={scrolled ? 0 : -1}
        aria-hidden={!scrolled}
        aria-label="Back to top"
        title="Back to top"
      >
        <span aria-hidden="true">↑</span>
      </button>
    </div>
  );
}
