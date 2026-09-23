'use client';

import { useEffect } from 'react';

/**
 * Brings `.reveal` elements in as they reach the reading band: a short fade
 * and lift, once, never again on the way back up.
 *
 * One IntersectionObserver for the page, not a scroll listener, so the
 * browser does the geometry off the main thread. The page is fully readable
 * without it: the hidden starting state only applies once this has marked
 * the document (`data-reveal="on"`), and never under reduced motion.
 */
export default function RevealObserver() {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const root = document.documentElement;
    const nodes = [...document.querySelectorAll('.reveal')]
      // Anything already on screen stays put rather than fading in under the cursor.
      .filter(node => node.getBoundingClientRect().top > window.innerHeight * 0.9);
    if (!nodes.length) return undefined;
    for (const node of nodes) node.classList.add('is-pending');
    root.dataset.reveal = 'on';
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.remove('is-pending');
        observer.unobserve(entry.target);
      }
    }, { rootMargin: '0px 0px -12% 0px' });
    for (const node of nodes) observer.observe(node);
    return () => {
      observer.disconnect();
      for (const node of nodes) node.classList.remove('is-pending');
      delete root.dataset.reveal;
    };
  }, []);
  return null;
}
