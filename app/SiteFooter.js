import Link from 'next/link';
import { BrandMark } from './SiteHeader.js';

/**
 * The build stamp is rendered on the server, so it is correct in the HTML
 * rather than appearing a moment later.
 *
 * The columns list every route this site has and nothing else. A footer is the
 * usual place a link farm grows — a column of category pages that were never
 * built, a "Blog" that 404s — and each dead entry costs more trust than the
 * column was ever going to earn.
 */
const COLUMNS = [
  {
    title: 'Explore',
    links: [
      { href: '/', label: 'Discover' },
      { href: '/#catalog', label: 'The collection' },
      { href: '/plan', label: 'Space planner' }
    ]
  },
  {
    title: 'For stores',
    links: [
      { href: '/portal', label: 'Store portal' },
      { href: '/portal#apply', label: 'Apply to list' }
    ]
  },
  /*
     Its own category, not a line inside Help.

     "Will this work on my phone" is not the same kind of question as "how
     much does it cost" — it is the one standing between a visitor and the
     only feature this site exists for, and it is the first thing asked when
     the scanner does not start. Buried as the middle entry of a Help column
     it reads as troubleshooting for people who already failed; given its own
     heading it reads as something to check first.

     Two real destinations, both of which exist. The footer's own rule at the
     top of this file still holds: no category pages that were never built.
  */
  {
    title: 'Your device',
    links: [
      { href: '/diagnose', label: 'Does my phone work?' },
      { href: '/#faq', label: 'What AR needs' }
    ]
  },
  {
    title: 'Help',
    links: [
      { href: '/#faq', label: 'Common questions' },
      { href: 'mailto:hello@furnishar.ph?subject=FurnishAR%20enquiry', label: 'hello@furnishar.ph', external: true }
    ]
  }
];

export default function SiteFooter() {
  const version = process.env.npm_package_version || '1.1.0';
  const commit = (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || 'dev';

  return (
    <footer>
      <div className="footer-inner">
        <div className="footer-about">
          <span className="brand footer-brand">
            <BrandMark />
            <span>Furnish<span>AR</span></span>
          </span>
          <p>Spatial planning for the homes of Mamburao.</p>
          <p>Android Chrome + ARCore recommended for live placement.</p>
        </div>

        <nav className="footer-columns" aria-label="Footer">
          {COLUMNS.map(column => (
            <div className="footer-column" key={column.title}>
              <h2>{column.title}</h2>
              <ul>
                {column.links.map(link => (
                  <li key={link.href}>
                    {link.external
                      ? <a href={link.href}>{link.label}</a>
                      : <Link href={link.href}>{link.label}</Link>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>

      <p className="build-stamp">v{version} · {commit}</p>
    </footer>
  );
}
