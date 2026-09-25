'use client';

import { useEffect, useId, useRef, useState } from 'react';

/**
 * An in-page confirmation for something that cannot be undone.
 *
 * Replaces `window.confirm`, which had three problems worth fixing: it is
 * styled by the browser and looks nothing like the rest of the interface, it
 * blocks the main thread so nothing behind it can even repaint, and on several
 * mobile browsers a site that calls it repeatedly gets a "prevent this page
 * from creating more dialogs" checkbox — after which destructive actions
 * silently succeed with no prompt at all.
 *
 * A real <dialog> with showModal() gets the focus trap, the Escape key, inert
 * background content and the top layer from the browser, which is the whole
 * reason not to hand-roll one out of divs.
 *
 * `onCancel` runs on every close path — the Cancel button, Escape, the
 * backdrop — because a dialog that unmounts only on the happy path leaves the
 * caller waiting on an answer that is never coming.
 */
export default function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  destructive = true,
  // For the rare action that cannot be undone AND costs someone else their
  // work: the confirm button stays disabled until this word is typed.
  confirmPhrase = null,
  children = null,
  onConfirm,
  onCancel
}) {
  const [typed, setTyped] = useState('');
  const phraseId = useId();
  const phraseOk = !confirmPhrase || typed.trim() === confirmPhrase;
  const dialogRef = useRef(null);
  // Distinguishes "closed because the user confirmed" from every other way a
  // dialog can close, so confirming does not also fire onCancel.
  const confirmed = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog?.open) dialog?.showModal();
    const handleClose = () => {
      if (!confirmed.current) onCancel();
    };
    dialog?.addEventListener('close', handleClose);
    return () => dialog?.removeEventListener('close', handleClose);
  }, [onCancel]);

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-body"
    >
      <h2 id="confirm-title">{title}</h2>
      <p id="confirm-body">{body}</p>
      {children}
      {confirmPhrase && (
        <label className="confirm-phrase" htmlFor={phraseId}>
          Type <b translate="no">{confirmPhrase}</b> to confirm
          <input id={phraseId} type="text" autoComplete="off" autoCapitalize="characters" spellCheck={false}
            value={typed} onChange={event => setTyped(event.target.value)} />
        </label>
      )}
      <div className="confirm-actions">
        <button
          className="button"
          type="button"
          // Cancel takes focus, so a stray Enter on a dialog someone did not
          // read backs out instead of deleting their product. Confirming a
          // destructive action should cost a deliberate Tab.
          autoFocus={destructive}
          onClick={() => dialogRef.current?.close()}
        >
          {cancelLabel}
        </button>
        <button
          className={`button ${destructive ? 'button-danger' : 'button-primary'}`}
          type="button"
          autoFocus={!destructive}
          disabled={!phraseOk}
          onClick={() => {
            if (!phraseOk) return;
            confirmed.current = true;
            dialogRef.current?.close();
            onConfirm();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
