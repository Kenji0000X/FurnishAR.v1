'use client';

import { useEffect, useState } from 'react';

/**
 * Light / dark switch.
 *
 * The stored value is one of three things, and the third one matters:
 *
 *   'light' | 'dark'  — an explicit choice, which must beat the OS setting.
 *   null              — no choice made, so follow the OS.
 *
 * Collapsing that to a boolean is the usual bug: someone on a dark-mode phone
 * who has never touched the toggle gets remembered as "dark", and then when
 * they switch their phone to light the site stays dark forever with no way to
 * explain why.
 *
 * The matching no-flash script lives in app/layout.js and must apply the same
 * rule before first paint.
 */
const STORAGE_KEY = 'furnishar-theme';

/** What the page is showing right now, read from the DOM rather than guessed. */
function currentTheme() {
  if (typeof document === 'undefined') return 'light';
  const explicit = document.documentElement.dataset.theme;
  if (explicit === 'light' || explicit === 'dark') return explicit;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export default function ThemeToggle() {
  // Starts null so the server and the first client render agree; React would
  // otherwise warn about a hydration mismatch, since the server cannot know
  // what the visitor's OS prefers.
  const [theme, setTheme] = useState(null);

  useEffect(() => {
    setTheme(currentTheme());

    // Someone who has expressed no preference should follow their OS live,
    // including when it flips at sunset.
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystemChange = () => {
      if (!document.documentElement.dataset.theme) setTheme(currentTheme());
    };
    media.addEventListener('change', onSystemChange);
    return () => media.removeEventListener('change', onSystemChange);
  }, []);

  function toggle() {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private mode, or storage disabled. The theme still applies for this
      // page view; it just will not be remembered, which is not worth an error.
    }
  }

  const isDark = theme === 'dark';

  return (
    <button
      className="theme-toggle"
      type="button"
      onClick={toggle}
      aria-pressed={theme === null ? undefined : isDark}
      aria-label="Dark theme"
      title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
    >
      <span aria-hidden="true">{isDark ? '◑' : '◐'}</span>
    </button>
  );
}
