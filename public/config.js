/**
 * Runtime configuration.
 *
 * Left empty here on purpose, and it should STAY empty in a normal deployment.
 *
 * Whatever lands in this file is served to every visitor, so the preferred
 * setup puts nothing in it: name the deployment's variables `SUPABASE_URL` and
 * `SUPABASE_PUBLISHABLE_KEY` (no NEXT_PUBLIC_ prefix), and the credentials stay
 * on the server in lib/supabase-proxy.js. The browser reaches Supabase through
 * this app's own /api/sb/… routes and never sees a key. See SUPABASE.md §4.
 *
 * `npm run build` only fills this file in when it finds the legacy
 * NEXT_PUBLIC_* names, which ask for the old direct-to-Supabase mode. That mode
 * still works and row level security still protects the data — the anon key was
 * never the security boundary — but the key is then readable in DevTools and
 * can be spent against your quota.
 *
 * With neither configured the app falls back to the bundled JSON catalogue and
 * the demo sign-in, so local development keeps working untouched.
 *
 * The service role / secret key must never be put in this file, under any
 * name: it bypasses row level security.
 */
window.FURNISHAR_CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: '',
  version: '1.1.0',
  commit: 'dev',
  builtAt: null
};
