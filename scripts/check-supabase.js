#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

function readEnvFile() {
  const file = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(
    fs.readFileSync(file, 'utf8')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map(line => line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/))
      .filter(Boolean)
      .map(([, name, value]) => [name, value.replace(/^['"]|['"]$/g, '')])
  );
}

const fileEnv = readEnvFile();
const url = process.env.SUPABASE_URL || fileEnv.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || fileEnv.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_PUBLISHABLE_KEY || fileEnv.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || fileEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error('FAIL  Supabase variables are missing. Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in .env.local.');
  process.exit(1);
}
if (/service_role|^sb_secret_/i.test(key)) {
  console.error('FAIL  Use a publishable/anon key, not a service_role or sb_secret key.');
  process.exit(1);
}
let parsed;
try { parsed = new URL(url); } catch {
  console.error(`FAIL  SUPABASE_URL is not a valid URL: ${url}`);
  process.exit(1);
}

console.log(`OK    Configuration found for ${parsed.host}`);
(async () => {
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/auth/v1/health`, {
      headers: { apikey: key },
      signal: AbortSignal.timeout(8000)
    });
    console.log(`OK    Supabase is reachable (HTTP ${response.status})`);
    if (response.status >= 500) process.exitCode = 1;
  } catch (error) {
    console.error(`FAIL  Could not reach ${parsed.host}: ${error.cause?.code || error.message}`);
    console.error('      Copy the current Project URL from Supabase Settings -> API.');
    process.exitCode = 1;
  }
})();
