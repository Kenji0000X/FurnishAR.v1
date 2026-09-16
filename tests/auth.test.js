/**
 * The server-side gate in front of the admin tables.
 *
 * tests/admin.test.js proves the database refuses the wrong caller. This proves
 * the proxy refuses them one step earlier, and — the part that matters — that
 * it decides who they are by asking Supabase, never by believing the request.
 *
 * Every case asserts what the upstream was actually asked, not just what the
 * caller got back: a 403 is only worth anything if the queue was never fetched.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const ADMIN = 'jwt-belonging-to-the-admin';
const OWNER = 'jwt-belonging-to-a-store-owner';
const KEY = 'sb_publishable_authtest0000';

let asked = [];
let server;
let proxy;

/** Mirrors the real project: GoTrue confirms the token, the RPC answers the role. */
function start() {
  return new Promise(resolve => {
    server = http.createServer((req, res) => {
      const auth = req.headers.authorization || '';
      asked.push({ url: req.url, auth });
      const send = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      if (req.url.startsWith('/auth/v1/user')) {
        if (auth.includes(ADMIN)) return send(200, { id: 'admin-uuid', email: 'admin@furnishar.ph' });
        if (auth.includes(OWNER)) return send(200, { id: 'owner-uuid', email: 'owner@furnishar.ph' });
        return send(401, { message: 'invalid claim: missing sub claim' });
      }
      if (req.url.startsWith('/rest/v1/rpc/is_platform_admin')) return send(200, auth.includes(ADMIN));
      if (req.url.startsWith('/rest/v1/store_applications')) {
        return send(200, [{ id: 'app-1', contact_email: 'rattan@shop.ph' }]);
      }
      if (req.url.startsWith('/rest/v1/rpc/approve_store_application')) return send(200, { slug: 'x' });
      if (req.url.startsWith('/rest/v1/catalog')) return send(200, [{ id: 'p1' }]);
      send(200, []);
    });
    server.listen(0, () => resolve());
  });
}

const request = (method = 'GET', token = null) => ({
  method,
  headers: token ? { authorization: `Bearer ${token}` } : {}
});

/** Did anything actually ask for the applicants' details? */
const queueWasFetched = () => asked.some(call => call.url.startsWith('/rest/v1/store_applications'));

test.before(async () => {
  await start();
  process.env.SUPABASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.SUPABASE_PUBLISHABLE_KEY = KEY;
  proxy = require('../lib/supabase-proxy.js');
});
test.beforeEach(() => { asked = []; });
test.after(() => server?.close());

test('an anonymous caller is refused the sign-up queue, and it is never fetched', async () => {
  const result = await proxy.proxyRest(request(), 'store_applications?select=*', null);
  assert.equal(result.status, 401);
  assert.equal(queueWasFetched(), false);
});

test('a signed-in store owner gets 403, not an empty list that looks like an empty queue', async () => {
  const result = await proxy.proxyRest(request('GET', OWNER), 'store_applications?select=*', null);
  assert.equal(result.status, 403);
  assert.match(result.body.error, /platform administrators/i);
  assert.equal(queueWasFetched(), false);
});

test('the refusal says nothing about what is behind it', async () => {
  const result = await proxy.proxyRest(request('GET', OWNER), 'store_applications?select=*', null);
  const said = JSON.stringify(result.body);
  assert.ok(!said.includes('rattan@shop.ph'));
  assert.ok(!/\d+ (application|pending)/i.test(said));
});

test('an administrator is let through and gets the queue', async () => {
  const result = await proxy.proxyRest(request('GET', ADMIN), 'store_applications?select=*', null);
  assert.equal(result.status, 200);
  assert.equal(result.body[0].contact_email, 'rattan@shop.ph');
  assert.equal(queueWasFetched(), true);
});

test('a token Supabase will not confirm is 401, however well formed it looks', async () => {
  const result = await proxy.proxyRest(request('GET', 'expired.but.plausible'), 'admin_audit', null);
  assert.equal(result.status, 401);
  assert.match(result.body.error, /sign in again/i);
});

test('identity is taken from the token alone — claiming to be an admin buys nothing', async () => {
  const forged = {
    method: 'GET',
    headers: {
      authorization: `Bearer ${OWNER}`,
      'x-is-admin': 'true',
      'x-user-role': 'platform_admin',
      role: 'service_role'
    }
  };
  const result = await proxy.proxyRest(forged, 'platform_admins?select=*', null);
  assert.equal(result.status, 403);
});

test('a store owner cannot approve their own application through the proxy', async () => {
  const result = await proxy.proxyRest(
    request('POST', OWNER), 'rpc/approve_store_application', '{"application":"app-1"}'
  );
  assert.equal(result.status, 403);
  assert.equal(asked.some(call => call.url.includes('approve_store_application')), false);
});

test('anyone signed in may ask whether they themselves are an admin', async () => {
  // The portal needs this to decide whether to show the console link, and it
  // reports on the caller and nobody else.
  const result = await proxy.proxyRest(request('POST', OWNER), 'rpc/is_platform_admin', '{}');
  assert.equal(result.status, 200);
  assert.equal(result.body, false);
});

test('a prospective store owner can still file an application without being one', async () => {
  // The gate closed this once: sign-up succeeded but the application never
  // reached the queue, so nobody could ever be approved. Reading the pile is
  // admin-only; adding yourself to it is the public sign-up form.
  const result = await proxy.proxyRest(
    request('POST'), 'store_applications', '{"store_name":"Mindoro Rattan Works"}'
  );
  assert.equal(result.status, 200);
  assert.ok(asked.some(call => call.url.startsWith('/rest/v1/store_applications')));
});

test('filing one does not let you read the others', async () => {
  const result = await proxy.proxyRest(request('GET'), 'store_applications?select=*', null);
  assert.equal(result.status, 401);
});

test('the sign-up form is not a way into the other admin tables', async () => {
  for (const table of ['platform_admins', 'admin_audit']) {
    const result = await proxy.proxyRest(request('POST'), table, '{}');
    assert.equal(result.status, 401, `POST ${table} should be refused`);
  }
});

test('the gate does not stand in front of the ordinary catalogue', async () => {
  const result = await proxy.proxyRest(request(), 'catalog?select=*', null);
  assert.equal(result.status, 200);
  // No session lookup at all: shoppers are not made to prove anything.
  assert.equal(asked.some(call => call.url.startsWith('/auth/v1/user')), false);
});

test('the check is made on every request, so revoking access takes effect at once', async () => {
  await proxy.proxyRest(request('GET', ADMIN), 'store_applications', null);
  const first = asked.filter(call => call.url.includes('is_platform_admin')).length;
  asked = [];
  await proxy.proxyRest(request('GET', ADMIN), 'store_applications', null);
  const second = asked.filter(call => call.url.includes('is_platform_admin')).length;
  assert.equal(first, 1);
  assert.equal(second, 1, 'a cached answer would keep a removed admin signed in');
});
