// The design system is still the hand-written stylesheet documented in
// BRAND.md. It is imported from its original location rather than copied, so
// during the migration there is exactly one stylesheet and the legacy build
// and the Next build cannot drift apart. It moves to app/globals.css once the
// vanilla site is retired.
import '../public/styles.css';
import SiteHeader from './SiteHeader.js';
import SiteFooter from './SiteFooter.js';
import ChromeGate from './ChromeGate.js';
import BottomNav from './BottomNav.js';
import ScrollProgress from './ScrollProgress.js';
import PageTools from './PageTools.js';
import CookieNotice from './CookieNotice.js';

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
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#14483e' },
    { media: '(prefers-color-scheme: dark)', color: '#0e1513' }
  ],
  colorScheme: 'light dark',
  width: 'device-width',
  initialScale: 1
  // Pinch-zoom is deliberately NOT disabled here.
  //
  // It used to be, so that a page zoom could not fight the AR view's
  // centimetre readout. But this is the ROOT layout: that locked zoom on the
  // catalogue, the product pages, the store portal and the admin console too,
  // where there is nothing to fight and plenty of small type. Taking magnify
  // away from someone who needs it to read a price is a real cost, and WCAG
  // 1.4.4 says so.
  //
  // The AR view blocks the gesture where it actually matters instead —
  // `touch-action: none` on the camera surface — so the planner still behaves
  // and every other page can be zoomed.
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          Applies the saved theme BEFORE first paint.

          This has to be a blocking inline script in <head>. Anything later —
          a useEffect, a deferred bundle — runs after the browser has already
          painted, which is the white flash every dark-mode site gets wrong at
          least once. It is small and has no dependencies for that reason.

          Absence of a stored value deliberately leaves data-theme unset, so
          the CSS media query keeps control and the OS preference still wins.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('furnishar-theme');`
              + `if(t==='light'||t==='dark')document.documentElement.dataset.theme=t;}catch(e){}})()`
          }}
        />
      </head>
      <body>
        {/* Targets the <main> below, not #catalog.
            #catalog exists only on the home page, so on /plan, /portal,
            /admin and every product page this link used to go nowhere at
            all — the one control a keyboard user reaches first, and on four
            routes out of five it did nothing. */}
        <a className="skip-link" href="#main">Skip to content</a>
        <SiteHeader />
        <ScrollProgress />
        {/* tabIndex -1 so the jump actually moves focus, not just the
            scroll position; without it the next Tab returns to the header. */}
        <main id="main" tabIndex={-1}>{children}</main>
        <ChromeGate><SiteFooter /></ChromeGate>
        {/* Phones only, and shoppers only — it is the same shopper menu the
            burger opens, so it goes where the burger goes. Rendered after the
            footer so it is last in the tab order, where a bar pinned to the
            bottom of the screen belongs. */}
        <ChromeGate><BottomNav /></ChromeGate>
        <PageTools />
        <CookieNotice />
      </body>
    </html>
  );
}
