'use client';

import { useId, useState } from 'react';

/**
 * A password input with a reveal button.
 *
 * Typing a password blind on a phone keyboard is where sign-in attempts go to
 * die, and a store owner who mistypes theirs three times hits the rate limiter
 * and is locked out for reasons they cannot see. Letting them look is the
 * cheapest fix available.
 *
 * The button is `type="button"` on purpose: inside a <form> a bare <button>
 * submits, so a reveal toggle written the obvious way posts the form instead
 * of showing the password.
 *
 * It reports state with `aria-pressed` rather than swapping the label between
 * "Show" and "Hide", so a screen reader announces the control and its state
 * instead of a label that appears to change identity under the user.
 */
export default function PasswordField({ label = 'Password', name = 'password', ...inputProps }) {
  const [visible, setVisible] = useState(false);
  const id = useId();

  return (
    <label htmlFor={id}>
      {label}
      <span className="password-field">
        <input
          {...inputProps}
          id={id}
          name={name}
          type={visible ? 'text' : 'password'}
          required
        />
        <button
          className="password-reveal"
          type="button"
          onClick={() => setVisible(shown => !shown)}
          aria-pressed={visible}
          aria-controls={id}
          // Without this the control reads as just "button" once the visible
          // glyph is hidden from the accessibility tree.
          aria-label="Show password"
          title={visible ? 'Hide password' : 'Show password'}
        >
          <span aria-hidden="true">{visible ? '◎' : '○'}</span>
        </button>
      </span>
    </label>
  );
}
