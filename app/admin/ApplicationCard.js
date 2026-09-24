'use client';

import { useState } from 'react';
import { supabase } from '../portal/backend.js';
import { timeAgo, slugify } from './format.js';

/**
 * One applicant, and everything needed to decide about them.
 *
 * Lifted out of AdminConsole unchanged when the console became six routes —
 * the review card is the one piece of it with real behaviour, and it belongs
 * beside the page that shows it rather than buried in a shell.
 *
 * What protects this is NOT this file. `approve_store_application` re-checks
 * every fact shown here in its own transaction; the account state below is a
 * convenience for the reviewer, never the check itself.
 */

/**
 * "Email not confirmed" used to be a dead end — the applicant's account
 * exists, but Supabase only ever sent that one confirmation email at
 * sign-up, and if it landed in spam or was never seen, there was nothing an
 * admin (or the applicant) could do except wait indefinitely. Approve stayed
 * disabled with no path forward. This button asks Supabase to send it again.
 */
function ResendConfirmation({ email }) {
  const [state, setState] = useState('idle'); // idle | sending | sent | error

  async function resend() {
    setState('sending');
    try {
      await supabase().resendConfirmation(email);
      setState('sent');
    } catch {
      setState('error');
    }
  }

  if (state === 'sent') return <span className="verification-note">Sent — ask them to check spam too.</span>;
  return (
    <>
      <button className="text-button" type="button" onClick={resend} disabled={state === 'sending'}>
        {state === 'sending' && <span className="loading-spinner" aria-hidden="true" />}Resend Confirmation Email
      </button>
      {state === 'error' && <span className="verification-note">Couldn’t send it. Try again in a minute.</span>}
    </>
  );
}

function AccountState({ account, email }) {
  if (!account) return <dd>checking…</dd>;
  if (!account.found) return <dd className="verification-warning">no account with this address yet</dd>;
  if (account.disabled) return <dd className="verification-warning">the account is disabled</dd>;
  if (!account.confirmed) {
    return (
      <dd className="verification-warning">
        email not confirmed — cannot be approved yet
        <br />
        <ResendConfirmation email={email} />
      </dd>
    );
  }
  return (
    <dd className="verification-ok">
      email confirmed {timeAgo(account.confirmed_at)}
      {account.last_sign_in_at ? `, last signed in ${timeAgo(account.last_sign_in_at)}` : ', never signed in'}
    </dd>
  );
}

export default function ApplicationCard({ application, account, onApprove, onReject, busy }) {
  const [slug, setSlug] = useState(slugify(application.store_name));
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(null); // 'approve' | 'reject' | null

  return (
    <article className="review-card">
      <header className="review-head">
        <div>
          <h3>{application.store_name}</h3>
          <p className="review-meta">
            applied {timeAgo(application.created_at)}
          </p>
        </div>
        <span className={`review-status is-${application.status}`}>{application.status}</span>
      </header>

      {/* The details to check before letting someone list furniture publicly. */}
      <dl className="review-details">
        <div><dt>Contact email</dt><dd>{application.contact_email}</dd></div>
        <div><dt>Their account</dt><AccountState account={account} email={application.contact_email} /></div>
        <div><dt>Contact number</dt><dd>{application.contact_phone || '—'}</dd></div>
        <div><dt>What they will list</dt><dd>{application.message || '—'}</dd></div>
      </dl>

      {application.status === 'pending' && (
        <div className="review-actions">
          <label className="review-slug">
            Store address
            <span className="review-slug-row">
              <span aria-hidden="true">/furniture/…</span>
              <input
                value={slug}
                onChange={event => setSlug(slugify(event.target.value))}
                aria-label="Store slug"
              />
            </span>
          </label>

          <label>
            Note (kept on the record; required to reject)
            <input
              value={note}
              onChange={event => setNote(event.target.value)}
              placeholder="e.g. could not verify the business…"
            />
          </label>

          {confirming === 'approve' ? (
            <div className="review-confirm">
              <p>
                Approve <b>{application.store_name}</b>? This creates the store at
                <code> /{slug}</code> and gives <b>{application.contact_email}</b> the ability to
                publish furniture publicly.
              </p>
              <button className="button button-primary" type="button" disabled={busy}
                onClick={() => onApprove(application, slug)}>
                {busy && <span className="loading-spinner" aria-hidden="true" />}Yes, Approve
              </button>
              <button className="text-button" type="button" onClick={() => setConfirming(null)}>
                Cancel
              </button>
            </div>
          ) : confirming === 'reject' ? (
            <div className="review-confirm">
              <p>Reject <b>{application.store_name}</b>? They will need to apply again.</p>
              <button className="button button-outline" type="button" disabled={busy || !note.trim()}
                onClick={() => onReject(application, note)}>
                {busy && <span className="loading-spinner" aria-hidden="true" />}Yes, Reject
              </button>
              <button className="text-button" type="button" onClick={() => setConfirming(null)}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="review-buttons">
              {/* Approval is irreversible from here — it creates a store and
                  grants publishing rights — so it asks twice. */}
              {/* The database refuses an unconfirmed account anyway; greying
                  the button out says so before the reviewer commits to it. */}
              <button className="button button-primary" type="button"
                disabled={busy || !slug || !(account?.found && account.confirmed && !account.disabled)}
                onClick={() => setConfirming('approve')}>
                Approve
              </button>
              <button className="button button-outline" type="button" disabled={busy}
                onClick={() => setConfirming('reject')}>
                Reject
              </button>
            </div>
          )}
        </div>
      )}

      {application.status !== 'pending' && application.review_note && (
        <p className="review-note">Note: {application.review_note}</p>
      )}
    </article>
  );
}
