'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';

/**
 * "Sign in to do this" — asked at the moment somebody tries to do it.
 *
 * The alternative is to let them click, navigate to a page they cannot use,
 * and meet a wall there. That costs a page load to learn something the
 * button already knew, and it moves them away from the product they were
 * looking at. This keeps them on the product, says what happened, why, and
 * what they can do — and whichever they choose, the sign-in brings them back
 * to the exact thing they asked for (`next`), not to the home page.
 *
 * A real <dialog> for the same reasons as ConfirmDialog: the browser supplies
 * the focus trap, Escape, the inert background and the top layer. Focus goes
 * to the heading on open (BRAND.md §9), so a screen reader starts with what
 * happened rather than with a button; closing hands it back to the control
 * that opened it.
 */
export default function AuthGateDialog({ title, body, next, onClose }) {
  const dialogRef = useRef(null);
  const headingRef = useRef(null);
  const opener = useRef(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    opener.current = document.activeElement;
    if (!dialog?.open) dialog?.showModal();
    headingRef.current?.focus();
    const handleClose = () => {
      onClose();
      const back = opener.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
    dialog?.addEventListener('close', handleClose);
    return () => dialog?.removeEventListener('close', handleClose);
  }, [onClose]);

  const signIn = `/login?as=buyer&next=${encodeURIComponent(next)}`;

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog auth-gate"
      aria-labelledby="auth-gate-title"
      aria-describedby="auth-gate-body"
    >
      <h2 id="auth-gate-title" ref={headingRef} tabIndex={-1}>{title}</h2>
      <p id="auth-gate-body">{body}</p>
      <div className="confirm-actions">
        <button className="button" type="button" onClick={() => dialogRef.current?.close()}>
          Cancel
        </button>
        <Link className="button" href={`${signIn}&mode=signup`}>Create account</Link>
        <Link className="button button-primary" href={signIn}>
          Log in <span aria-hidden="true">→</span>
        </Link>
      </div>
    </dialog>
  );
}
