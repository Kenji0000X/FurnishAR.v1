import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/**
 * The server-side half of protecting the 3D models (see 0007 for the other).
 *
 * The rule under test: authentication and authorization are different
 * answers, and a guest, an expired session, a refused file and a broken
 * upstream each get their own — so the page can say "sign in", "sign in
 * again", "not available to this account" or "try again", instead of one
 * "failed to load" for all four.
 */
const require = createRequire(import.meta.url);

const SUPABASE = 'https://demo.supabase.co';
const PATH = '2b1c4e4e-0000-4000-8000-000000000002/6f1c4e4e-0000-4000-8000-000000000001/model.glb';
const saved = {};
let calls = [];
let grantModelAccess;

/** What the fake Supabase will answer, keyed by the kind of request. */
let answers = {};

before(() => {
  for (const name of ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY']) saved[name] = process.env[name];
  process.env.SUPABASE_URL = SUPABASE;
  process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_testkey000000';
  saved.fetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/auth/v1/user')) return answers.user();
    if (String(url).includes('/storage/v1/object/sign/')) return answers.sign(options);
    throw new Error(`unexpected request ${url}`);
  };
  ({ grantModelAccess } = require('../lib/supabase-proxy.js'));
});

after(() => {
  globalThis.fetch = saved.fetch;
  for (const [name, value] of Object.entries(saved)) {
    if (name === 'fetch') continue;
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

const request = token => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });
const json = (status, body) => new Response(JSON.stringify(body), { status });

test('a guest is told to sign in, and Supabase is never asked', async () => {
  calls = [];
  const result = await grantModelAccess(request(null), PATH);
  assert.equal(result.status, 401);
  assert.equal(result.body.code, 'auth_required');
  assert.equal(calls.length, 0, 'no token means no round trip at all');
});

test('a token GoTrue no longer honours is an EXPIRED session, not a guest', async () => {
  /* Signed out elsewhere, or expired past refresh. The JWT may still decode;
     what matters is that GoTrue will not stand behind it. */
  calls = [];
  answers.user = () => json(401, { message: 'invalid claim' });
  const result = await grantModelAccess(request('stale-token'), PATH);
  assert.equal(result.status, 401);
  assert.equal(result.body.code, 'session_expired');
  assert.ok(!calls.some(c => c.url.includes('/object/sign/')), 'never reaches storage');
});

test('a real session the storage policy refuses is "unavailable" — authenticated is not authorized', async () => {
  answers.user = () => json(200, { id: 'buyer-1', email: 'ana@example.ph' });
  answers.sign = () => json(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
  const result = await grantModelAccess(request('good-token'), PATH);
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'unavailable');
  assert.equal(result.body.url, undefined, 'no URL of any kind leaks on refusal');
  assert.doesNotMatch(JSON.stringify(result.body), /Object not found|not_found|storage/,
    'the storage message stays in the log');
});

test('an allowed file comes back as a short-lived signed URL, signed AS THE USER', async () => {
  calls = [];
  answers.user = () => json(200, { id: 'buyer-1' });
  answers.sign = () => json(200, { signedURL: `/object/sign/furniture-models/${PATH}?token=abc` });
  const result = await grantModelAccess(request('good-token'), PATH);
  assert.equal(result.status, 200);
  assert.equal(result.body.url, `${SUPABASE}/storage/v1/object/sign/furniture-models/${PATH}?token=abc`);
  assert.equal(result.body.expiresIn, 300);

  /* The authorization decision is the database's: the signing request must
     carry the caller's own token, never a key that would bypass the policy. */
  const signing = calls.find(c => c.url.includes('/object/sign/'));
  assert.equal(signing.options.headers.Authorization, 'Bearer good-token');
  assert.match(signing.options.headers.apikey, /^sb_publishable_/);
});

test('a path that is not a store/product/file is refused before anything is asked', async () => {
  calls = [];
  for (const bad of ['../../etc/passwd', 'x/y/z.glb', `${PATH}/../other`, '']) {
    const result = await grantModelAccess(request('good-token'), bad);
    assert.equal(result.status, 400, bad);
  }
  assert.equal(calls.length, 0);
});

test('an upstream that is down says so, rather than pretending the user lacks access', async () => {
  answers.user = () => json(200, { id: 'buyer-1' });
  answers.sign = () => json(503, { message: 'down' });
  const result = await grantModelAccess(request('good-token'), PATH);
  assert.equal(result.status, 502);
  assert.equal(result.body.code, 'upstream');
});
