/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Sent from the server only (lib/notify.js); loaded at run time rather
  // than bundled, the way Node libraries with optional native paths prefer.
  serverExternalPackages: ['nodemailer'],

  // The AR engine reaches for `window`, `navigator.xr` and a WebGL context at
  // module scope. None of that exists while rendering on the server, so the
  // component that mounts it is loaded with `ssr: false` (see
  // app/plan/ArExperience.js) rather than being coaxed into rendering twice.

  async headers() {
    return [
      {
        source: '/manifest.webmanifest',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Content-Type', value: 'application/manifest+json' }
        ]
      },
      {
        // WebXR and getUserMedia are permission-gated features; a page that
        // does not ask for them should not be able to. `self` keeps them
        // available to our own origin and denies every embedder.
        source: '/:path*',
        headers: [
          { key: 'Permissions-Policy', value: 'camera=(self), xr-spatial-tracking=(self), geolocation=()' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }
        ]
      },
      {
        // The home page's hero room and its still. Artwork for the page, not
        // catalogue products, and replaced by new files rather than edited,
        // so they can be cached hard.
        source: '/models/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }]
      }
    ];
  }
};

export default nextConfig;
