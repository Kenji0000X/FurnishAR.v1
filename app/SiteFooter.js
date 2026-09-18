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
