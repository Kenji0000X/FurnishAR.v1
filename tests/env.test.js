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

test('a secret key is refused outright, whatever it is named', () => {
  for (const secret of ['sb_secret_abcdef0123456789', 'a.service_role.token']) {
    assert.throws(() => assertPublishableKey(secret), /secret|service.role/i);
  }
  assert.doesNotThrow(() => assertPublishableKey(KEY_VALUE));
});
