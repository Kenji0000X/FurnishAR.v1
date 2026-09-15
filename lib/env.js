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
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    values[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return values;
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
  const read = name => process.env[name] || fromFiles[name] || '';
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

/** Throws if a key that must stay on a server is about to reach a browser. */
function assertPublishableKey(key) {
  if (/service_role/.test(key) || /^sb_secret_/.test(key)) {
    throw new Error(
      'That Supabase key is a secret/service-role key. Use the publishable (anon) key — ' +
      'the secret one bypasses row level security and must never reach a browser.'
    );
  }
}

module.exports = { loadSupabaseEnv, assertPublishableKey, URL_NAMES, KEY_NAMES };
