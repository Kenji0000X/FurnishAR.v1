'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { canPlaceInSpace } from '../../model-state.js';

/**
 * The buttons under a product.
 *
 * Which one leads is device-dependent: iPhones open a USDZ in Quick Look,
 * everything else goes to the planner where the WebXR engine lives. That test
 * needs `navigator`, so it runs after mount — the server renders the safe
 * option and this upgrades it, rather than guessing from a user-agent header
 * and getting it wrong for someone.
 */
export default function ProductActions({ product }) {
  const [isIOS, setIsIOS] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const ua = navigator.userAgent;
    setIsIOS(
      /iPad|iPhone|iPod/.test(ua) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    );
  }, []);

  const planHref = `/plan?product=${product.slug || product.id}`;
  const quickLook = isIOS && product.modelUsdz;
  // Offered only when the planner has something to place. Before this, every
  // product carried "Place in your room" whether or not a model existed, and
  // the two that had none sent the shopper to an empty planner.
  const placeable = canPlaceInSpace(product);

  async function copyLink() {
    const url = window.location.href;
    try {
      // The share sheet is the better answer on a phone; the clipboard is the
      // fallback everywhere else.
      if (navigator.share) {
        await navigator.share({ title: product.name, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // A cancelled share sheet is not an error worth reporting.
    }
  }

  return (
    <div className="product-actions">
      {placeable && (quickLook ? (
        <a className="button button-primary" rel="ar" href={product.modelUsdz}>
          Open in AR
        </a>
      ) : (
        <Link className="button button-primary" href={`${planHref}&ar=1`}>
          View in my space
        </Link>
      ))}

      {/* Measuring a room works with or without a model — you are measuring
          the room, and the dimensions above are real either way. So this stays
          offered, and becomes the primary action when there is nothing to
          place. */}
      <Link
        className={`button ${placeable ? 'button-outline' : 'button-primary'}`}
        href={placeable ? planHref : '/plan'}
      >
        Measure my space
      </Link>

      <button className="button button-outline" type="button" onClick={copyLink}>
        {copied ? 'Link copied' : 'Copy link to this piece'}
      </button>
    </div>
  );
}
