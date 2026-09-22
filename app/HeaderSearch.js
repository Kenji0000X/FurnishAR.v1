'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Site search, in the header.
 *
 * This exists only because it can be made to work. An earlier version of the
 * header deliberately left search out, next to a comment explaining why: a
 * magnifying glass that leads nowhere is the "button that does nothing" every
 * redesign brief bans two sections after asking for it.
 *
 * So it is a real form. Submitting navigates to /collection?q=… and the
 * catalogue reads that parameter into its own filter, which means the term
 * survives the trip, the URL can be shared, and a term that matches nothing
 * lands on the catalogue's honest empty state rather than on a full grid
 * pretending the search ran.
 */
export default function HeaderSearch() {
  const router = useRouter();
  const [term, setTerm] = useState('');

  function submit(event) {
    event.preventDefault();
    const query = term.trim();
    router.push(query ? `/collection?q=${encodeURIComponent(query)}` : '/collection');
  }

  return (
    <form className="header-search" role="search" onSubmit={submit}>
      <label htmlFor="site-search" className="sr-only">Search furniture</label>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
      </svg>
      <input
        id="site-search"
        type="search"
        placeholder="Search pieces"
        value={term}
        onChange={event => setTerm(event.target.value)}
      />
    </form>
  );
}
