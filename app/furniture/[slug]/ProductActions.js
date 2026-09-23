'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { canPlaceInSpace } from '../../model-state.js';
import { initBackend, usingSupabase, supabase } from '../../portal/backend.js';
import AuthGateDialog from '../../AuthGateDialog.js';

/**
 * The buttons under a product.
 *
 * WHAT IS PUBLIC HERE, AND WHAT IS NOT
 * Everything on this page is public — the name, the photo, the dimensions,
 * the price. The 3D model is not: it is opened only in the planner, and only
 * for a signed-in account the storage policy allows (0007).
 *
 * This component used to render, on an iPhone, <a rel="ar" href={modelUsdz}>
 * — a direct link to the model FILE, for anyone, guests included. It no
 * longer links to a model at all. Both buttons go to the planner, which is
 * the one place a model is opened and the one place access is checked; on an
 * iPhone the planner hands the placement to Quick Look itself, on a real tap,
 * with a URL that already carries its permission.
 *
 * WHY THE GATE IS HERE AS WELL AS AT /plan
 * /plan refuses a guest either way — that is the rule, and it holds with
 * JavaScript off. But sending a guest there to meet a wall costs a page load
 * to learn what this button already knows, and takes them away from the
 * piece. So a guest is asked here, in a dialog, and whichever way they sign
 * in, `next` returns them to this exact piece in the planner.
 */
export default function ProductActions({ product }) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const [role, setRole] = useState(null);       // null = not known yet
  const [gate, setGate] = useState(null);       // { title, body, next } | null

  const planHref = `/plan?product=${encodeURIComponent(product.slug || product.id)}`;
  const placeHref = `${planHref}&ar=1`;
  // Offered only when the planner has something to place. Before this, every
  // product carried "Place in your room" whether or not a model existed, and
  // the two that had none sent the shopper to an empty planner.
  const placeable = canPlaceInSpace(product);

  /* Who is looking, asked once after mount. For a guest this costs nothing —
     with no session there is nothing to ask the server — so the click below
     can decide without a round trip. */
  const learnRole = useCallback(async () => {
    await initBackend();
    if (!usingSupabase()) return 'open';          // no accounts exist to require
    /* Unanswered is not "guest": go to the planner, which says what is wrong
       rather than offering a sign-in that cannot work right now. */
    return supabase().myRole().catch(() => 'unknown');
  }, []);

  useEffect(() => {
    let alive = true;
    learnRole().then(value => { if (alive) setRole(value); });
    return () => { alive = false; };
  }, [learnRole]);

  async function go(event, href, ask) {
    // Modified clicks (new tab, etc.) keep their normal behaviour; /plan
    // enforces the same rule on arrival.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) return;
    event.preventDefault();
    const who = role ?? await learnRole();
    if (!role) setRole(who);
    if (who === 'guest') setGate({ ...ask, next: href });
    else router.push(href);
  }

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
      {placeable && (
        <Link
          className="button button-primary"
          href={placeHref}
          onClick={event => go(event, placeHref, {
            title: 'Sign in to view this furniture in 3D.',
            body: `Create a free account or sign in to continue. You will come straight back to the ${product.name}.`
          })}
        >
          View in my space
        </Link>
      )}

      {/* Measuring a room works with or without a model — you are measuring
          the room, and the dimensions above are real either way. So this stays
          offered, and becomes the primary action when there is nothing to
          place. */}
      <Link
        className={`button ${placeable ? 'button-outline' : 'button-primary'}`}
        href={placeable ? planHref : '/plan'}
        onClick={event => go(event, placeable ? planHref : '/plan', {
          title: 'Sign in to measure your space.',
          body: 'Create a free account or sign in to continue. Browsing stays open to everyone.'
        })}
      >
        Measure my space
      </Link>

      <button className="button button-outline" type="button" onClick={copyLink}>
        {copied ? 'Link copied' : 'Copy link to this piece'}
      </button>

      {gate && (
        <AuthGateDialog
          title={gate.title}
          body={gate.body}
          next={gate.next}
          onClose={() => setGate(null)}
        />
      )}
    </div>
  );
}
