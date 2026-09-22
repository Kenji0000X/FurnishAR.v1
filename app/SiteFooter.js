import Link from 'next/link';
import { BrandMark } from './SiteHeader.js';

/**
 * One band, not a wall.
 *
 * The previous footer was four stacked columns and ran most of the height of a
 * phone screen — on a page whose last section was already a call to action, it
 * doubled the distance to the bottom of the document for no gain. This is the
 * same information in a single row: who this is, three short groups, and the
 * build stamp.
 *
 * It still lists only routes that exist. A footer is the usual place a link
 * farm grows — a "Blog" that 404s, a column of category pages nobody built —
 * and every dead entry costs more trust than the column was going to earn.
 *
 * It is not rendered at all on /portal and /admin (see ChromeGate).
 */
const GROUPS = [
  {
    title: 'Explore',
    links: [
      { href: '/collection', label: 'The collection' },
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
      { href: '/diagnose', label: 'Does my phone work?' },
      { href: '/faq', label: 'Common questions' }
    ]
  }
];

export default function SiteFooter() {
  const version = process.env.npm_package_version || '1.1.0';
  const commit = (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || 'dev';

  return (
    <footer className="site-footer">
      <div className="footer-band">
        <div className="footer-identity">
          <span className="brand footer-brand">
            <BrandMark />
            <span>Furnish<span>AR</span></span>
          </span>
          <p>Spatial planning for the homes of Mamburao.</p>
        </div>

        <nav className="footer-groups" aria-label="Footer">
          {GROUPS.map(group => (
            <div className="footer-group" key={group.title}>
              <h2>{group.title}</h2>
              {group.links.map(link => (
                <Link key={link.href} href={link.href}>{link.label}</Link>
              ))}
            </div>
          ))}
        </nav>

        <p className="build-stamp">v{version} · {commit}</p>
      </div>
    </footer>
  );
}
