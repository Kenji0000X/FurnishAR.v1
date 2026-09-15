import { BrandMark } from './SiteHeader.js';

/**
 * The build stamp used to be filled in by JS from window.FURNISHAR_CONFIG. It
 * is rendered on the server now, so it is correct in the HTML rather than
 * appearing a moment later — and it no longer needs the config object that
 * once carried the Supabase key.
 */
export default function SiteFooter() {
  const version = process.env.npm_package_version || '1.1.0';
  const commit = (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || 'dev';

  return (
    <footer>
      <span className="brand footer-brand">
        <BrandMark />
        <span>Furnish<span>AR</span></span>
      </span>
      <p>Spatial planning for the homes of Mamburao.</p>
      <p>Android Chrome + ARCore recommended for live placement.</p>
      <p className="build-stamp">v{version} · {commit}</p>
    </footer>
  );
}
