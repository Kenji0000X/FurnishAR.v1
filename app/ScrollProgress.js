'use client';

import { useEffect, useState } from 'react';

/**
 * A thin bar under the header showing how far down the page you are.
 *
 * Reads scroll position in a rAF-throttled listener rather than on every
 * scroll event: scroll fires far faster than the screen refreshes, and doing
 * layout reads in that handler is the classic way to make a page feel heavy
 * on exactly the low-end phones this app targets. `passive: true` for the same
 * reason — it promises the browser this listener will never call
 * preventDefault, so scrolling is never blocked waiting on it.
 *
 * Hidden from assistive tech: it is decorative, and a live-updating percentage
 * announced on every scroll would be actively hostile.
 */
export default function ScrollProgress() {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let frame = 0;

    const measure = () => {
      frame = 0;
      const { scrollTop, scrollHeight, clientHeight } = document.documentElement;
      const scrollable = scrollHeight - clientHeight;
      // A page shorter than the viewport has nothing to progress through;
      // without this guard it divides by zero and renders NaN.
      setProgress(scrollable > 0 ? Math.min(1, scrollTop / scrollable) : 0);
    };

    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  return (
    <div className="scroll-progress" aria-hidden="true">
      <span style={{ transform: `scaleX(${progress})` }} />
    </div>
  );
}
