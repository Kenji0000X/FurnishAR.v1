'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * A catalogue poster, with an honest failure.
 *
 * A poster that will not load (a removed file, a network hiccup) must not
 * leave a broken-image icon, and must not say "No 3D model" either — the
 * model may be perfectly fine; only its picture is missing. So a failure
 * swaps in the same neutral frame the card uses for no picture, worded as
 * what it is. This is the only client code on a card: the rest of it, and
 * the image tag itself, are server-rendered HTML.
 */
export default function PosterImage({ src, alt, className, sizes, priority }) {
  const [failed, setFailed] = useState(false);
  const ref = useRef(null);
  // The <img> is server-rendered, so a poster can fail before React has
  // attached onError — the event has already happened. Check on mount too.
  useEffect(() => {
    const img = ref.current;
    if (img && img.complete && img.naturalWidth === 0) setFailed(true);
  }, []);
  if (failed) {
    return (
      <span className={`${className} product-thumb-empty`} role="img" aria-label={`${alt}: preview unavailable`}>
        <span aria-hidden="true">⬚</span>
        <small aria-hidden="true">Preview unavailable</small>
      </span>
    );
  }
  return (
    <img
      ref={ref}
      className={className}
      src={src}
      alt={alt}
      // The posters' real size (app/portal/poster.js), so the browser
      // reserves the square before a byte arrives and nothing jumps.
      width="640"
      height="640"
      sizes={sizes}
      loading={priority ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : 'auto'}
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}
