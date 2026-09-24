/**
 * The server half of 0011: PayPal configuration and seller status, the
 * webhook processor, payment-setup reminders, Google sign-in (PKCE) and
 * onboarding — against a fake Supabase and a fake PayPal.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const BASE_ENV = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test000000000000000',
  PAYPAL_CLIENT_ID: 'client-id',
  PAYPAL_CLIENT_SECRET: 'client-secret',
  PAYMENT_RECORDER_SECRET: 'x'.repeat(40),
  PAYPAL_PARTNER_MERCHANT_ID: 'PARTNER123',
  PAYPAL_WEBHOOK_ID: 'WH-ID-1',
  GMAIL_USER: '',
  RESEND_API_KEY: ''
};
const VARIABLES = ['PAYPAL_ENV', 'PAYPAL_FEE_MODE', 'PAYPAL_SELLER_ONBOARDING', 'PAYPAL_PARTNER_ATTRIBUTION_ID', 'PAYPAL_PLATFORM_FEE_RATE',
  'PAYPAL_REMINDER_COOLDOWN_HOURS', 'PAYPAL_REMINDER_MAX', 'EMAIL_FROM'];

function resetEnv(extra = {}) {
  for (const name of VARIABLES) delete process.env[name];
  Object.assign(process.env, BASE_ENV, extra);
}
resetEnv();

const paypal = require('../lib/paypal.js');
const payments = require('../lib/payments.js');
const oauth = require('../lib/oauth.js');
const account = require('../lib/account.js');
const notify = require('../lib/notify.js');

const reply = (status, body, headers = {}) =>
  new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

let calls;
let routes;
function fakeFetch() {
  calls = [];
  global.fetch = async (url, options = {}) => {
    const body = typeof options.body === 'string' && options.body.startsWith('{') ? JSON.parse(options.body) : options.body;
    calls.push({ url: String(url), method: options.method || 'GET', body, headers: options.headers || {} });
    for (const [pattern, handler] of routes) {
      if (String(url).includes(pattern)) return handler(body, String(url), options);
    }
    return reply(404, {});
  };
}
test.beforeEach(() => {
  resetEnv();
  routes = [['/v1/oauth2/token', () => reply(200, { access_token: 'pp', expires_in: 3600 })]];
  fakeFetch();
});

/* ------------------------------------------------------------- config --- */

test('PayPal is sandbox unless PAYPAL_ENV says live, exactly', () => {
  assert.equal(paypal.validateConfig().env, 'sandbox');
  resetEnv({ PAYPAL_ENV: 'Live ' });
  assert.equal(paypal.validateConfig().env, 'live');
  resetEnv({ PAYPAL_ENV: 'production' });
  const config = paypal.validateConfig();
  assert.equal(config.env, 'sandbox');
  assert.ok(config.problems.some(p => /PAYPAL_ENV/.test(p)));
  assert.equal(paypal.credentials().base, 'https://api-m.sandbox.paypal.com');
});

test('platform_split is only reported when the partner is fully configured', () => {
  resetEnv({ PAYPAL_FEE_MODE: 'platform_split' });
  let config = paypal.validateConfig();
  assert.equal(config.feeModeConfigured, 'platform_split');
  assert.equal(config.feeMode, 'accrual');                 // no attribution id: not a split
  assert.ok(config.problems.some(p => /ATTRIBUTION/.test(p)));
  resetEnv({ PAYPAL_FEE_MODE: 'platform_split', PAYPAL_PARTNER_ATTRIBUTION_ID: 'FA_SP' });
  config = paypal.validateConfig();
  assert.equal(config.feeMode, 'platform_split');
  resetEnv({ PAYPAL_FEE_MODE: 'split-it' });
  assert.equal(paypal.validateConfig().feeMode, 'accrual');
  resetEnv({ PAYPAL_PLATFORM_FEE_RATE: '0.2' });
  assert.ok(paypal.validateConfig().problems.some(p => /database charges 0.1/.test(p)));
  // Nothing secret is ever in the report.
  assert.ok(!JSON.stringify(paypal.validateConfig()).includes('client-secret'));
});

/* ------------------------------------------------------ seller status --- */

test('a seller is CONNECTED only with permissions, a confirmed email and receivable payments', () => {
  const granted = { oauth_integrations: [{ oauth_third_party: [{ scopes: [
    'https://uri.paypal.com/services/payments/realtimepayment',
    'https://uri.paypal.com/services/payments/partnerfee'] }] }] };
  assert.equal(paypal.sellerStatus(null).status, 'ONBOARDING_STARTED');
  assert.equal(paypal.sellerStatus({ merchant_id: 'M1', payments_receivable: true, primary_email_confirmed: true }).status, 'ERROR');
  assert.equal(paypal.sellerStatus({ merchant_id: 'M1', payments_receivable: true, primary_email_confirmed: false, ...granted }).status, 'PENDING');
  assert.equal(paypal.sellerStatus({ merchant_id: 'M1', payments_receivable: false, primary_email_confirmed: true, ...granted }).status, 'PAYMENTS_NEED_ATTENTION');
  assert.equal(paypal.sellerStatus({ merchant_id: 'M1', payments_receivable: true, primary_email_confirmed: true, ...granted,
    capabilities: [{ name: 'CUSTOM_CARD_PROCESSING', status: 'SUSPENDED' }] }).status, 'LIMITED');
  const ok = paypal.sellerStatus({ merchant_id: 'M1', payments_receivable: true, primary_email_confirmed: true, ...granted });
  assert.equal(ok.status, 'CONNECTED');
  assert.equal(ok.partnerFee, true);
});

test('connecting a store records the attempt first, then asks PayPal for a referral link', async () => {
  resetEnv({ PAYPAL_SELLER_ONBOARDING: 'partner_referrals' });
  routes.push(
    ['/auth/v1/user', () => reply(200, { id: 'owner-1', email: 'owner@gmail.com' })],
    ['/rpc/server_payment_onboarding_started', () => reply(200, { ok: true })],
    ['/v2/customer/partner-referrals', () => reply(201, { links: [{ rel: 'action_url', href: 'https://www.sandbox.paypal.com/onboard' }] })]
  );
  const store = '11111111-2222-4333-8444-555555555555';
  const result = await payments.handlePayments({ method: 'POST', headers: { authorization: 'Bearer owner-jwt' } },
    'connect', { storeId: store }, 'https://furnishar.test');
  assert.equal(result.status, 200);
  assert.equal(result.body.actionUrl, 'https://www.sandbox.paypal.com/onboard');
  const started = calls.findIndex(c => c.url.includes('server_payment_onboarding_started'));
  const referral = calls.findIndex(c => c.url.includes('partner-referrals'));
  assert.ok(started >= 0 && started < referral, 'membership is checked before PayPal is asked');
  assert.equal(calls[started].headers.Authorization, 'Bearer owner-jwt');
  const body = calls[referral].body;
  assert.match(body.tracking_id, new RegExp(`^fa-${store}-[0-9a-f]{12}$`));
  assert.equal(body.partner_config_override.return_url, 'https://furnishar.test/portal?paypal_onboarding=return#billing');
  assert.deepEqual(body.operations[0].api_integration_preference.rest_api_integration.third_party_details.features, ['PAYMENT', 'REFUND']);
});

/* ----------------------------------------------- linking by Merchant ID --- */

const STORE = '11111111-2222-4333-8444-555555555555';
const owner = { method: 'POST', headers: { authorization: 'Bearer owner-jwt' } };

function linkRoutes(payee) {
  routes.push(
    ['/auth/v1/user', () => reply(200, { id: 'owner-1', email: 'owner@gmail.com' })],
    ['/rpc/server_payment_onboarding_started', () => reply(200, { ok: true })],
    ['/rpc/server_record_payment_account', body => reply(200, { found: true, store_id: STORE, before: 'NOT_CONNECTED', status: body.p_status })],
    ['/rpc/server_store_contacts', () => reply(200, { store_id: STORE, store_name: 'Shop', store_emails: ['o@x'] })],
    ['/rpc/server_admin_emails', () => reply(200, [])],
    ['/v2/checkout/orders', () => payee]
  );
}

test('Merchant-ID linking is the default and needs no partner approval', () => {
  resetEnv({ PAYPAL_PARTNER_MERCHANT_ID: '' });
  const config = paypal.validateConfig();
  assert.equal(config.sellerMode, 'merchant_id');
  assert.equal(config.onboarding, true);
  assert.ok(!config.problems.some(p => /PARTNER_MERCHANT_ID/.test(p)));
});

test('a Merchant ID is connected only after the owner check AND PayPal accepting it as a payee', async () => {
  linkRoutes(reply(201, { id: 'CHECKORDER1', status: 'CREATED' }));
  const result = await payments.handlePayments(owner, 'link', { storeId: STORE, merchantId: ' 7xk2qj9lmn4pa ' }, 'https://s');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.status, 'CONNECTED');
  const started = calls.findIndex(c => c.url.includes('server_payment_onboarding_started'));
  const check = calls.findIndex(c => c.url.endsWith('/v2/checkout/orders'));
  const recorded = calls.findIndex(c => c.url.includes('server_record_payment_account'));
  assert.ok(started >= 0 && started < check && check < recorded, 'owner check → PayPal check → record');
  const order = calls[check].body;
  assert.deepEqual(order.purchase_units[0].payee, { merchant_id: '7XK2QJ9LMN4PA' });
  assert.equal(order.purchase_units[0].amount.value, '1.00');
  assert.ok(!calls.some(c => c.url.includes('/capture')), 'the check is never captured');
  assert.equal(calls[recorded].body.p_status, 'CONNECTED');
  assert.equal(calls[recorded].body.p_merchant_id, '7XK2QJ9LMN4PA');
  assert.equal(calls[recorded].body.p_partner_fee, false);
});

test('an id PayPal refuses as a payee is not connected, and says why', async () => {
  linkRoutes(reply(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'PAYEE_ACCOUNT_INVALID' }] }));
  const result = await payments.handlePayments(owner, 'link', { storeId: STORE, merchantId: 'FAKEMERCHANT1' }, 'https://s');
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'payee_invalid');
  assert.match(result.body.error, /does not recognise that Merchant ID/);
  const recorded = calls.find(c => c.url.includes('server_record_payment_account'));
  assert.equal(recorded.body.p_status, 'ERROR');
});

test('a malformed id never reaches PayPal; partner connect is off in this mode; admin-only disconnect', async () => {
  linkRoutes(reply(201, {}));
  let result = await payments.handlePayments(owner, 'link', { storeId: STORE, merchantId: 'x@y.com' }, 'https://s');
  assert.equal(result.status, 400);
  assert.ok(!calls.some(c => c.url.includes('/v2/checkout/orders') || c.url.includes('/rpc/')));
  result = await payments.handlePayments(owner, 'connect', { storeId: STORE }, 'https://s');
  assert.equal(result.status, 409);
  routes.push(['/rpc/is_platform_admin', () => reply(200, false)]);
  result = await payments.handlePayments(owner, 'admin-unlink', { storeId: STORE }, 'https://s');
  assert.equal(result.status, 403);
  assert.ok(!calls.some(c => c.url.includes('server_record_payment_account')));
});

/* ------------------------------------------------------------ webhooks --- */

function webhookHeaders() {
  return {
    'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT',
    'paypal-transmission-id': 't-1', 'paypal-transmission-sig': 'sig', 'paypal-transmission-time': '2026-09-24T00:00:00Z'
  };
}

test('an unverified webhook is refused before anything is read', async () => {
  routes.push(['/verify-webhook-signature', () => reply(200, { verification_status: 'FAILURE' })]);
  const event = { id: 'WH-1', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'R1' } };
  const result = await payments.handleWebhook(webhookHeaders(), JSON.stringify(event), 'https://s');
  assert.equal(result.status, 400);
  assert.ok(!calls.some(c => c.url.includes('/rest/v1/')));

  // A certificate URL that is not PayPal's is not even sent for verification.
  calls.length = 0;
  const forged = { ...webhookHeaders(), 'paypal-cert-url': 'https://evil.example/cert' };
  assert.equal((await payments.handleWebhook(forged, JSON.stringify(event), 'https://s')).status, 400);
  assert.ok(!calls.some(c => c.url.includes('verify-webhook-signature')));
});

test('a verified refund webhook is recorded once, with the platform portion', async () => {
  let claimed = false;
  routes.push(
    ['/verify-webhook-signature', body => reply(200, { verification_status: body.webhook_id === 'WH-ID-1' ? 'SUCCESS' : 'FAILURE' })],
    ['/rpc/server_claim_webhook_event', () => { const first = !claimed; claimed = true; return reply(200, first); }],
    ['/rpc/server_record_refund', () => reply(200, { order_id: 'o1', recorded: true, completed: true, amount: 1100, platform_fee_refunded: 100 })],
    ['/rpc/server_order_contacts', () => reply(200, { reference: 'R', buyer_email: 'b@x', store_emails: ['s@x'], store_name: 'S', product_name: 'P', quantity: 1 })],
    ['/rpc/server_finish_webhook_event', () => reply(200, null)]
  );
  const event = { id: 'WH-7', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: {
    id: 'REFUND1', status: 'COMPLETED', amount: { value: '1100.00', currency_code: 'PHP' },
    seller_payable_breakdown: { platform_fees: [{ amount: { value: '100.00', currency_code: 'PHP' } }] },
    links: [{ rel: 'up', href: 'https://api.sandbox.paypal.com/v2/payments/captures/CAPTURE9' }] } };
  const first = await payments.handleWebhook(webhookHeaders(), JSON.stringify(event), 'https://s');
  assert.equal(first.status, 200);
  const refund = calls.find(c => c.url.includes('server_record_refund')).body;
  assert.equal(refund.p_capture, 'CAPTURE9');
  assert.equal(refund.p_fee_refunded, 100);
  assert.equal(refund.p_secret, 'x'.repeat(40));
  assert.ok(!('authorization' in calls.find(c => c.url.includes('server_record_refund')).headers));
  assert.ok(calls.some(c => c.url.includes('server_finish_webhook_event')));

  calls.length = 0;
  const again = await payments.handleWebhook(webhookHeaders(), JSON.stringify(event), 'https://s');
  assert.equal(again.body.duplicate, true);
  assert.ok(!calls.some(c => c.url.includes('server_record_refund')));
});

test('a failed webhook is left unfinished so PayPal retries', async () => {
  routes.push(
    ['/verify-webhook-signature', () => reply(200, { verification_status: 'SUCCESS' })],
    ['/rpc/server_claim_webhook_event', () => reply(200, true)],
    ['/rpc/server_record_refund', () => reply(500, { message: 'boom' })]
  );
  const event = { id: 'WH-8', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: {
    id: 'REFUND2', amount: { value: '1.00', currency_code: 'PHP' },
    links: [{ rel: 'up', href: 'https://x/v2/payments/captures/CAP2' }] } };
  const result = await payments.handleWebhook(webhookHeaders(), JSON.stringify(event), 'https://s');
  assert.equal(result.status, 500);
  assert.ok(!calls.some(c => c.url.includes('server_finish_webhook_event')));
});

/* ---------------------------------------------------------- reminders --- */

test('a reminder counts only when an email actually went out', async () => {
  routes.push(
    ['/rpc/server_stores_needing_payment_setup', body => reply(200, [{ store_id: 's1', store_name: 'Shop', status: 'NOT_CONNECTED', reminder_count: 0 }])],
    ['/rpc/server_store_contacts', () => reply(200, { store_id: 's1', store_name: 'Shop', store_emails: ['owner@gmail.com'] })],
    ['/rpc/server_mark_payment_reminder', () => reply(200, { count: 1 })]
  );
  let result = await payments.sendPaymentReminders('https://s');     // no email transport configured
  assert.equal(result.sent, 0);
  assert.ok(!calls.some(c => c.url.includes('server_mark_payment_reminder')));
  assert.equal(calls.find(c => c.url.includes('needing_payment_setup')).body.p_cooldown_hours, 72);

  resetEnv({ RESEND_API_KEY: 're_test', EMAIL_FROM: 'FurnishAR <x@furnishar.ph>', PAYPAL_REMINDER_COOLDOWN_HOURS: '24' });
  routes.push(['api.resend.com', () => reply(200, { id: 'e1' })]);
  calls.length = 0;
  result = await payments.sendPaymentReminders('https://s');
  assert.equal(result.sent, 1);
  assert.equal(result.cooldownHours, 24);
  assert.ok(calls.some(c => c.url.includes('server_mark_payment_reminder')));
  const email = calls.find(c => c.url.includes('api.resend.com')).body;
  assert.match(email.subject, /Finish payment setup/);
  assert.match(email.text, /portal#billing/);
});

/* ------------------------------------------------------ Google sign-in --- */

test('Google sign-in keeps the verifier on the server and only a safe next', async () => {
  routes.push(['/auth/v1/authorize', () => new Response(null, { status: 302,
    headers: { location: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&state=s' } })]);
  const start = await oauth.startGoogle({ site: 'https://furnishar.test', next: 'https://evil.example', intent: 'buyer' });
  assert.equal(start.status, 302);
  assert.match(start.location, /^https:\/\/accounts\.google\.com\//);
  assert.match(start.cookie, /HttpOnly/);
  assert.match(start.cookie, /Secure/);
  assert.match(start.cookie, /Path=\/api\/sb\/auth/);
  const asked = new URL(calls.find(c => c.url.includes('/authorize')).url);
  assert.equal(asked.searchParams.get('provider'), 'google');
  assert.equal(asked.searchParams.get('redirect_to'), 'https://furnishar.test/auth/callback');
  assert.equal(asked.searchParams.get('code_challenge_method'), 's256');
  assert.equal(asked.searchParams.get('scopes'), null);                 // identity scopes only
  const flow = oauth.readCookie(start.cookie.split(';')[0]);
  assert.equal(flow.n, null);                                           // the open redirect was dropped
  assert.equal(flow.i, 'buyer');
  assert.ok(!start.location.includes(flow.v));                          // the verifier never leaves
  assert.equal(oauth.safeNext('/furniture/oak-chair?x=1'), '/furniture/oak-chair?x=1');
  for (const bad of ['//evil.example', '/\\evil.example', 'javascript:alert(1)', '/api/sb/auth/google', '/auth/callback?code=1']) {
    assert.equal(oauth.safeNext(bad), null, bad);
  }
});

test('Google not enabled in Supabase is "provider unavailable", not a JSON error page', async () => {
  routes.push(['/auth/v1/authorize', () => reply(400, { msg: 'Unsupported provider: provider is not enabled' })]);
  const start = await oauth.startGoogle({ site: 'https://furnishar.test', next: '/plan', intent: 'store' });
  assert.equal(start.location, 'https://furnishar.test/portal?oauth_error=provider_unavailable');
  assert.equal(start.cookie, undefined);
});

test('the code exchange drops Google\'s tokens and is good once', async () => {
  routes.push(['/auth/v1/authorize', () => new Response(null, { status: 302, headers: { location: 'https://accounts.google.com/x' } })]);
  const start = await oauth.startGoogle({ site: 'https://furnishar.test', next: '/furniture/oak-chair', intent: null });
  const cookie = start.cookie.split(';')[0];
  let exchanges = 0;
  routes.push(['/auth/v1/token?grant_type=pkce', body => {
    exchanges += 1;
    if (exchanges > 1) return reply(404, { error_code: 'flow_state_not_found' });
    assert.ok(body.code_verifier && body.auth_code === 'good-code-123');
    return reply(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600, expires_at: 9, token_type: 'bearer',
      provider_token: 'GOOGLE-ACCESS', provider_refresh_token: 'GOOGLE-REFRESH',
      user: { id: 'u1', email: 'maria@gmail.com', user_metadata: { full_name: 'Maria', avatar_url: 'x', provider_id: '123' } } });
  }]);
  const done = await oauth.exchangeCode({ code: 'good-code-123', cookieHeader: cookie, site: 'https://furnishar.test' });
  assert.equal(done.status, 200);
  assert.equal(done.body.next, '/furniture/oak-chair');
  assert.equal(done.body.session.access_token, 'at');
  const text = JSON.stringify(done.body);
  assert.ok(!text.includes('GOOGLE-ACCESS') && !text.includes('GOOGLE-REFRESH') && !text.includes('provider_id'));
  assert.match(done.cookie, /Max-Age=0/);

  const replay = await oauth.exchangeCode({ code: 'good-code-123', cookieHeader: cookie, site: 'https://furnishar.test' });
  assert.equal(replay.body.code, 'already_used');
  assert.equal((await oauth.exchangeCode({ code: 'good-code-123', cookieHeader: '', site: 'https://s' })).body.code, 'state_missing');
  assert.equal((await oauth.exchangeCode({ code: '', cookieHeader: cookie, site: 'https://s' })).body.code, 'missing_code');
  const stale = Buffer.from(JSON.stringify({ v: 'v', n: null, i: null, t: Date.now() - 11 * 60_000 })).toString('base64url');
  assert.equal((await oauth.exchangeCode({ code: 'good-code-123', cookieHeader: `fa_oauth=${stale}`, site: 'https://s' })).body.code, 'expired');
});

/* ---------------------------------------------------------- onboarding --- */

test('buyer onboarding sends the municipality and nothing that decides a role', async () => {
  routes.push(
    ['/auth/v1/user', () => reply(200, { id: 'u1', email: 'maria@gmail.com' })],
    ['/rpc/complete_buyer_onboarding', () => reply(200, { created: true, role: 'buyer', full_name: 'Maria', email: 'maria@gmail.com' })]
  );
  const result = await account.handleAccount({ method: 'POST', headers: { authorization: 'Bearer u1-jwt' } }, 'buyer',
    { municipality: 'Mamburao', role: 'admin', isAdmin: true }, 'https://s');
  assert.equal(result.status, 200);
  assert.equal(result.body.role, 'buyer');
  const sent = calls.find(c => c.url.includes('complete_buyer_onboarding'));
  assert.deepEqual(Object.keys(sent.body).sort(), ['p_full_name', 'p_municipality']);
  assert.equal(sent.headers.Authorization, 'Bearer u1-jwt');
  assert.equal((await account.handleAccount({ method: 'POST', headers: {} }, 'buyer', {}, 'https://s')).status, 401);
  assert.equal((await account.handleAccount({ method: 'POST', headers: {} }, 'promote', {}, 'https://s')).status, 404);
});

test('every new email event has a recipient, a subject and no raw HTML from its data', () => {
  const c = {
    email: 'maria@gmail.com', full_name: 'Maria <script>', contact_email: 'shop@gmail.com', store_name: 'Shop',
    admin_emails: ['admin@furnishar.ph'], store_emails: ['owner@gmail.com'], buyer_email: 'b@gmail.com',
    reference: 'R1', product_name: 'Chair', quantity: 1, refund_amount: 1100, refund_platform_fee: 100,
    platform_fee: 1000, amount: 11000, stage: 'full', fee_mode: 'accrual', status: 'LIMITED', detail: 'x', sandbox: true
  };
  for (const event of ['buyer_welcome', 'store_application_received', 'store_application_admin_notice', 'store_approved',
    'store_rejected', 'paypal_connection_required', 'paypal_connected', 'paypal_connection_problem', 'payment_failed',
    'refund_completed', 'platform_fee_recorded']) {
    const messages = notify.messagesFor(event, c, 'https://s');
    assert.ok(messages.length, event);
    for (const m of messages) {
      assert.ok(m.to && (Array.isArray(m.to) ? m.to.length : true), event);
      assert.ok(m.subject, event);
      assert.ok(!notify.render(m).html.includes('<script>'), event);
    }
  }
  const [fee] = notify.messagesFor('platform_fee_recorded', c, 'https://s');
  assert.match(fee.heading, /accrued/);                                       // never "collected" in accrual
  assert.match(notify.messagesFor('platform_fee_recorded', { ...c, fee_mode: 'platform_split' }, 'https://s')[0].heading, /collected/);
});
