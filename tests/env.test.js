/**
 * The one rule these tests exist to defend:
 *
 *   A Supabase key must never reach the browser bundle unless it was named
 *   NEXT_PUBLIC_*, which is an explicit request to publish it.
 *
 * This regressed once already — every spelling was accepted and then inlined
 * into dist/config.js, so following the documented "server-only" setup still
 * published the key. If one of these fails, the key is on the wire.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { publicBundleCredentials, assertPublishableKey } = require('../lib/env.js');

const URL_VALUE = 'https://example-project.supabase.co';
const KEY_VALUE = 'sb_publishable_TESTKEY0000000000';

/** A loadSupabaseEnv()-shaped result, without touching the real environment. */
function env(urlFrom, keyFrom) {
  const configured = Boolean(urlFrom && keyFrom);
  return {
    supabaseUrl: urlFrom ? URL_VALUE : '',
    supabaseAnonKey: keyFrom ? KEY_VALUE : '',
    urlFrom,
    keyFrom,
    configured
  };
}

test('server-only names keep the key out of the browser bundle', () => {
  const bundle = publicBundleCredentials(env('SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY'));
  assert.equal(bundle.mode, 'proxy');
  assert.equal(bundle.supabaseAnonKey, '', 'the key must not be bundled');
  assert.equal(bundle.supabaseUrl, '', 'the project URL must not be bundled either');
});

test('the legacy SUPABASE_ANON_KEY spelling is also treated as server-only', () => {
  const bundle = publicBundleCredentials(env('SUPABASE_URL', 'SUPABASE_ANON_KEY'));
  assert.equal(bundle.mode, 'proxy');
  assert.equal(bundle.supabaseAnonKey, '');
});

test('NEXT_PUBLIC_* names opt in to direct mode and do bundle the key', () => {
  const bundle = publicBundleCredentials(
    env('NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY')
  );
  assert.equal(bundle.mode, 'direct');
  assert.equal(bundle.supabaseAnonKey, KEY_VALUE);
  assert.equal(bundle.supabaseUrl, URL_VALUE);
});

test('a mixed pair fails safe: nothing is published', () => {
  for (const pair of [
    ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY'],
    ['SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY']
  ]) {
    const bundle = publicBundleCredentials(env(...pair));
    assert.equal(bundle.supabaseAnonKey, '', `${pair.join(' + ')} must not bundle the key`);
    assert.equal(bundle.mode, 'proxy');
    assert.equal(bundle.mixed, true, 'the mismatch should be reported so it can be fixed');
  }
});

test('an unconfigured deployment bundles nothing and reports no mode', () => {
  const bundle = publicBundleCredentials(env(null, null));
  assert.equal(bundle.mode, 'none');
  assert.equal(bundle.supabaseAnonKey, '');
  assert.equal(bundle.mixed, false);
});

test('the proxy refuses to serve requests with a secret key', () => {
  // The proxy documented this rule long before it enforced it. A secret key
  // bypasses row level security, so a deployment configured with one looks
  // healthy while being wide open — it has to fail loudly instead.
  const proxy = require('../lib/supabase-proxy.js');
  const previous = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_PUBLISHABLE_KEY };
  process.env.SUPABASE_URL = 'https://example-project.supabase.co';
  try {
    process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_secret_abcdef0123456789';
    assert.throws(() => proxy.serverCredentials(), /secret\/service_role key/i);
    assert.throws(() => proxy.isConfigured(), /secret\/service_role key/i);

    process.env.SUPABASE_PUBLISHABLE_KEY = KEY_VALUE;
    assert.equal(proxy.serverCredentials().key, KEY_VALUE);
    assert.equal(proxy.isConfigured(), true);
  } finally {
    for (const [name, value] of [['SUPABASE_URL', previous.url], ['SUPABASE_PUBLISHABLE_KEY', previous.key]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('a secret key is refused outright, whatever it is named', () => {
  for (const secret of ['sb_secret_abcdef0123456789', 'a.service_role.token']) {
    assert.throws(() => assertPublishableKey(secret), /secret|service.role/i);
  }
  assert.doesNotThrow(() => assertPublishableKey(KEY_VALUE));
});
