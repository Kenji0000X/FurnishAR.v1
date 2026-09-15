// The design system is still the hand-written stylesheet documented in
// BRAND.md. It is imported from its original location rather than copied, so
// during the migration there is exactly one stylesheet and the legacy build
// and the Next build cannot drift apart. It moves to app/globals.css once the
// vanilla site is retired.
import '../public/styles.css';
import SiteHeader from './SiteHeader.js';
import SiteFooter from './SiteFooter.js';

export const metadata = {
  title: {
    default: 'FurnishAR | See it. Fit it. Love it.',
    template: '%s | FurnishAR'
  },
  description:
    'FurnishAR helps shoppers in Mamburao see true-to-scale furniture before they buy.',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'FurnishAR' },
  // Declaring `icons` at all turns off Next's file-based icon detection, so
  // the tab icon has to be named here too — otherwise browsers fall back to
  // requesting /favicon.ico and 404.
  icons: {
    icon: '/icon.svg',
    shortcut: '/icon.svg',
    apple: '/icon.svg'
  }
};

export const viewport = {
  themeColor: '#14483e',
  colorScheme: 'light',
  width: 'device-width',
  initialScale: 1,
  // The AR view positions its own controls in centimetres of real space; a
  // pinch-zoom of the page on top of that fights the measurement readout.
  maximumScale: 1,
  userScalable: false
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#catalog">Skip to catalog</a>
        <SiteHeader />
        <main>{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
