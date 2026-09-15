/**
 * Runtime configuration.
 *
 * Left empty here on purpose. `npm run build` overwrites this file in dist/
 * from the deployment's environment variables:
 *
 *     SUPABASE_URL=https://<project-ref>.supabase.co
 *     SUPABASE_ANON_KEY=<the anon/publishable key>
 *
 * With both set, the app talks to Supabase: real accounts, per-store
 * furniture, model uploads and a live catalogue. With either missing it falls
 * back to the bundled JSON catalogue and the demo sign-in, so local
 * development and the current deployment keep working untouched.
 *
 * Only the anon key belongs here. It is safe in a browser because every table
 * is protected by row level security. The service role key must never be put
 * in this file.
 */
window.FURNISHAR_CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: ''
};
