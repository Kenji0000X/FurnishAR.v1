#!/usr/bin/env node
/**
 * Connection check for the Supabase backend.
 *
 *     npm run check:supabase
 *
 * Reads the same credentials the build does (process.env, then .env.local,
 * then .env) and proves, one step at a time, that this project can actually
 * use the project behind them. Every failure names the fix.
 *
 * Run it from a machine with internet access — it talks to your project over
 * HTTPS. Nothing here writes data.
 */
const { loadSupabaseEnv, URL_NAMES, KEY_NAMES } = require('../lib/env.js');

const PASS = '  ok   ';
const FAIL = ' FAIL  ';
const WARN = ' warn  ';
let failures = 0;

function report(state, title, detail) {
  if (state === FAIL) failures++;
  console.log(`${state}${title}`);
  if (detail) console.log(`       ${String(detail).split('\n').join('\n       ')}`);
}

async function request(url, key, path, options = {}) {
  const response = await fetch(`${url}${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* empty or not json */ }
  return { status: response.status, ok: response.ok, body, text };
}

/**
 * A proxy, firewall or captive portal can answer with the same status codes
 * Supabase uses. A real PostgREST/GoTrue reply is JSON; anything else on an
 * auth failure means the request never reached the project.
 */
function looksLikeSupabase(result) {
  return result.body !== null && typeof result.body === 'object';
}

(async () => {
  console.log('\nFurnishAR → Supabase connection check\n');

  // 1. Credentials present
  const { supabaseUrl, supabaseAnonKey, urlFrom, keyFrom, configured } = loadSupabaseEnv();
  if (!configured) {
    report(FAIL, 'Credentials found', [
      `No URL and key found. Set one name from each list, in .env.local or your host's settings:`,
      `  URL: ${URL_NAMES.join(' | ')}`,
      `  key: ${KEY_NAMES.join(' | ')}`
    ].join('\n'));
    console.log('\nWithout these the app serves the bundled catalogue, which is a valid mode — but nothing below can be checked.\n');
    process.exit(1);
  }
  report(PASS, 'Credentials found', `URL from ${urlFrom}, key from ${keyFrom}\n${supabaseUrl}\nkey ${supabaseAnonKey.slice(0, 16)}…`);

  // 2. The key is the public one, not a secret
  if (/service_role/.test(supabaseAnonKey) || /^sb_secret_/.test(supabaseAnonKey)) {
    report(FAIL, 'Key is publishable, not secret', 'This is a secret/service-role key. It bypasses row level security and must never reach a browser. Use the publishable (anon) key.');
    process.exit(1);
  }
  report(PASS, 'Key is publishable, not secret', /^sb_publishable_/.test(supabaseAnonKey)
    ? 'New-style publishable key.'
    : 'Legacy anon key (JWT). Still supported.');

  // 3. The project answers, and the key is accepted
  let rest;
  try {
    rest = await request(supabaseUrl, supabaseAnonKey, '/rest/v1/');
  } catch (error) {
    report(FAIL, 'Project reachable', `${error.message}\nCheck the URL, and that you have internet access.`);
    process.exit(1);
  }
  if ((rest.status === 401 || rest.status === 403) && !looksLikeSupabase(rest)) {
    report(FAIL, 'Request reached Supabase', [
      `HTTP ${rest.status}, but the reply did not come from Supabase:`,
      `  ${(rest.text || '').slice(0, 160).replace(/\s+/g, ' ')}`,
      'Something between this machine and Supabase blocked the request — a proxy,',
      'firewall or network allowlist. Your key is not the problem. Run this from a',
      'normal internet connection.'
    ].join('\n'));
    process.exit(1);
  }
  if (rest.status === 401 || rest.status === 403) {
    report(FAIL, 'Key accepted', `HTTP ${rest.status}: ${rest.body?.message || rest.body?.msg || 'rejected'}\nCopy the key again from Settings → API keys, and make sure it belongs to this project.`);
    process.exit(1);
  }
  report(PASS, 'Project reachable and key accepted', `HTTP ${rest.status} from /rest/v1/`);

  // 4. The schema this app expects
  const shopperTables = ['catalog', 'stores'];
  for (const table of shopperTables) {
    const result = await request(supabaseUrl, supabaseAnonKey, `/rest/v1/${table}?select=*&limit=1`);
    if (result.status === 404 || result.body?.code === '42P01') {
      report(FAIL, `Table "${table}" exists`, 'Not found. Run supabase/migrations/0001_init.sql in the SQL editor.');
    } else if (!result.ok) {
      report(FAIL, `Table "${table}" readable`, `HTTP ${result.status} ${result.body?.message || ''}`);
    } else {
      report(PASS, `Table "${table}" readable by the public`, `${result.body?.length ?? 0} row(s) visible to an anonymous visitor`);
    }
  }

  // 5. Seed data
  const stores = await request(supabaseUrl, supabaseAnonKey, '/rest/v1/stores?select=slug,name&limit=10');
  if (stores.ok) {
    const names = (stores.body || []).map(s => s.slug);
    if (!names.length) report(WARN, 'Stores seeded', 'No stores yet. Run supabase/seed.sql to create the three pilot shops.');
    else report(PASS, 'Stores seeded', names.join(', '));
  }
  const catalog = await request(supabaseUrl, supabaseAnonKey, '/rest/v1/catalog?select=name,model_glb_path&limit=10');
  if (catalog.ok) {
    const rows = catalog.body || [];
    if (!rows.length) report(WARN, 'Published furniture', 'The catalogue is empty. The app will show "no furniture matches". Publish a product, or run supabase/seed.sql.');
    else report(PASS, 'Published furniture', rows.map(r => `${r.name}${r.model_glb_path ? ' (has 3D model)' : ' (no model uploaded yet)'}`).join('\n'));
  }

  // 6. Drafts must never be visible to the public
  const drafts = await request(supabaseUrl, supabaseAnonKey, '/rest/v1/products?select=id,status&status=eq.draft&limit=1');
  if (drafts.ok && (drafts.body || []).length > 0) {
    report(FAIL, 'Drafts hidden from the public', 'An anonymous request can read draft products. Row level security is not doing its job — re-run the migration.');
  } else {
    report(PASS, 'Drafts hidden from the public', 'Anonymous requests see published rows only.');
  }

  // 7. The application queue must be closed to readers
  const queue = await request(supabaseUrl, supabaseAnonKey, '/rest/v1/store_applications?select=id&limit=1');
  if (queue.ok && Array.isArray(queue.body)) {
    report(FAIL, 'Sign-up queue is private', 'Anonymous requests can read store_applications. Re-run the migration — the public should only be able to insert.');
  } else {
    report(PASS, 'Sign-up queue is private', `HTTP ${queue.status} — reads refused, as intended.`);
  }

  // 8. Storage bucket for the 3D models
  const bucket = await fetch(`${supabaseUrl}/storage/v1/object/public/furniture-models/`, { method: 'HEAD' })
    .then(r => r.status).catch(() => 0);
  if (bucket === 0) report(WARN, 'Model storage reachable', 'Could not reach Storage.');
  else if (bucket === 404 || bucket === 400) report(WARN, 'Model storage bucket', 'The "furniture-models" bucket may not exist. The migration creates it; check Storage in the dashboard.');
  else report(PASS, 'Model storage reachable', `HTTP ${bucket}`);

  // 9. Email sign-in enabled
  const settings = await request(supabaseUrl, supabaseAnonKey, '/auth/v1/settings');
  if (settings.ok) {
    const emailOn = settings.body?.external?.email;
    report(emailOn ? PASS : FAIL, 'Email sign-in enabled',
      emailOn
        ? `Confirmation required: ${settings.body?.mailer_autoconfirm === false ? 'yes' : 'no'}`
        : 'Email provider is off. Owners cannot sign in. Enable it under Authentication → Providers.');
  }

  console.log(failures === 0
    ? '\nAll checks passed. Run `npm run build` and deploy — the app will use this project.\n'
    : `\n${failures} check(s) failed. Fix those and run this again.\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(error => {
  console.error('\nCheck aborted:', error.message, '\n');
  process.exit(1);
});
