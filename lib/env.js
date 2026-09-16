/**
 * Where the Supabase credentials come from, in one place, so the build and the
 * connection check can never disagree about which variable wins.
 *
 * Order of precedence:
 *   1. process.env      — what Vercel injects, and what a shell exports
 *   2. .env.local       — the file Supabase's dashboard tells you to create
 *   3. .env
 *
 * Supabase has renamed these keys more than once, and the dashboard hands out
 * NEXT_PUBLIC_* names whatever framework you picked. Every spelling is
 * accepted so nobody has to rename a working variable.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function readEnvFile(file) {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    values[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return values;
}

/**
 * Cleans a credential copied out of a dashboard and pasted into a settings box.
 *
 * Every one of these mistakes produced an unexplained 500 in production, so
 * they are repaired rather than diagnosed: surrounding quotes, stray
 * whitespace or a trailing newline, and the whole `NAME=value` line pasted
 * into the value field.
 */
function cleanCredential(raw, name) {
  let value = String(raw ?? '').trim();
  if (!value) return '';
  // "value" or 'value'
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  // NAME=value, pasted whole
  const prefix = new RegExp(`^${name}\\s*=\\s*`, 'i');
  if (prefix.test(value)) value = value.replace(prefix, '').trim();
  return value;
}

/**
 * Checks a Supabase project URL is something fetch() can actually use, and
 * says exactly what is wrong when it is not. An invalid URL makes fetch throw,
 * which used to surface as a bare 500.
 */
function assertUsableUrl(url, source = 'SUPABASE_URL') {
  if (!url) return url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `${source} is not a usable URL: "${url}". It should look like ` +
      'https://your-project-ref.supabase.co — copy it from Supabase → Settings → API → Project URL.'
    );
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error(
      `${source} must start with https:// — got "${url}".`
    );
  }
  return url;
}

const URL_NAMES = ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL'];
const KEY_NAMES = [
  'SUPABASE_ANON_KEY',
  'SUPABASE_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'
];

function loadSupabaseEnv() {
  const fromFiles = {
    ...readEnvFile(path.join(ROOT, '.env')),
    ...readEnvFile(path.join(ROOT, '.env.local'))
  };
  const read = name => cleanCredential(process.env[name] || fromFiles[name] || '', name);
  const pick = names => {
    for (const name of names) {
      const value = read(name);
      if (value) return { value: value.replace(/\/$/, ''), name };
    }
    return { value: '', name: null };
  };

  const url = pick(URL_NAMES);
  const key = pick(KEY_NAMES);
  return {
    supabaseUrl: url.value,
    supabaseAnonKey: key.value,
    urlFrom: url.name,
    keyFrom: key.name,
    configured: Boolean(url.value && key.value)
  };
}

/**
 * Should the browser bundle carry the credentials?
 *
 * Only when they were named `NEXT_PUBLIC_*`. That prefix means exactly one
 * thing — "publish this value to every visitor" — so we treat it as the opt-in
 * to direct-to-Supabase mode, and nothing else. Credentials named
 * `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` stay on the server and are
 * reached through /api/sb/… instead.
 *
 * Getting this wrong in the safe direction costs a websocket. Getting it wrong
 * in the other direction publishes a key, so a mixed pair is treated as private.
 */
function publicBundleCredentials(env = loadSupabaseEnv()) {
  const isPublicName = name => Boolean(name) && name.startsWith('NEXT_PUBLIC_');
  const bothPublic = isPublicName(env.urlFrom) && isPublicName(env.keyFrom);
  const mixed = env.configured && !bothPublic &&
    (isPublicName(env.urlFrom) || isPublicName(env.keyFrom));

  if (!env.configured || !bothPublic) {
    return { supabaseUrl: '', supabaseAnonKey: '', mode: env.configured ? 'proxy' : 'none', mixed };
  }
  return {
    supabaseUrl: env.supabaseUrl,
    supabaseAnonKey: env.supabaseAnonKey,
    mode: 'direct',
    mixed: false
  };
}

/** Throws if a key that must stay on a server is about to reach a browser. */
function assertPublishableKey(key) {
  if (/service_role/.test(key) || /^sb_secret_/.test(key)) {
    throw new Error(
      'That Supabase key is a secret/service-role key. Use the publishable (anon) key — ' +
      'the secret one bypasses row level security and must never reach a browser.'
    );
  }
}

module.exports = {
  loadSupabaseEnv,
  publicBundleCredentials,
  assertPublishableKey,
  cleanCredential,
  assertUsableUrl,
  URL_NAMES,
  KEY_NAMES
};
