/**
 * The two portals, and the wall between them, driven in a real browser.
 *
 * tests/admin.test.js proves the database refuses the wrong caller. This proves
 * the app in front of it behaves — that a non-admin reaching /admin is told no
 * and shown nothing, and that an admin sees the queue and can act on it.
 *
 * It stands up a fake Supabase that enforces the same rule the real policies
 * do: the review queue and the decision RPCs answer only for the admin's
 * token. If the app ever started trusting a client-side flag instead of the
 * server's answer, the non-admin case here would start passing data through.
 *
 *   node scripts/check-admin.mjs
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const SUPABASE_PORT = 4601;
const APP_PORT = 4602;
const KEY = 'sb_publishable_adminmock00000';

const ADMIN_TOKEN = 'token-for-the-admin';
const OWNER_TOKEN = 'token-for-a-store-owner';

// Toggled by the "stray membership" test below. The real bug this guards:
// the app assumed an admin account is never a store_members row for any
// shop, but nothing enforced that in the data — an admin who once signed up
// for a store, or was added to one by hand, keeps that row. This flag
// reproduces that state on demand rather than changing what every other
// test in this file sees.
let adminHasStrayMembership = false;

let applications = [
  {
    id: 'app-1', store_name: 'Mindoro Rattan Works', contact_email: 'rattan@shop.ph',
    contact_phone: '+63431234567', message: '30 pieces, mostly chairs',
    status: 'pending', created_at: new Date(Date.now() - 3600e3).toISOString(), review_note: null
  },
  // The reported bug: an applicant whose account exists but whose
  // confirmation email never arrived. approve_store_application correctly
  // refuses this one — the check below is that the console offers a way
  // forward instead of a dead "nothing happens".
  {
    id: 'app-stuck', store_name: 'Stuck Signup Co', contact_email: 'stuck@shop.ph',
    contact_phone: '+63439998888', message: 'waiting on a confirmation email',
    status: 'pending', created_at: new Date(Date.now() - 1800e3).toISOString(), review_note: null
  }
];
let audit = [];
const calls = [];

/** The rule the real RLS policies enforce, mirrored here. */
const isAdmin = req => (req.headers.authorization || '').includes(ADMIN_TOKEN);

const supabase = createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    calls.push({ url: req.url, admin: isAdmin(req) });
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.url.startsWith('/auth/v1/health')) {
      return req.headers.apikey === KEY ? send(200, { name: 'GoTrue' }) : send(401, {});
    }
    if (req.url.startsWith('/auth/v1/resend')) return send(200, {});
    // The server-side gate (lib/auth.js) confirms every token here before it
    // will pass an admin request through.
    if (req.url.startsWith('/auth/v1/user')) {
      const auth = req.headers.authorization || '';
      if (auth.includes(ADMIN_TOKEN)) return send(200, { id: ADMIN_TOKEN, email: 'admin@furnishar.ph' });
      if (auth.includes(OWNER_TOKEN)) return send(200, { id: OWNER_TOKEN, email: 'owner@furnishar.ph' });
      return send(401, { message: 'invalid claim' });
    }
    if (req.url.includes('grant_type=password')) {
      const who = String(raw).includes('admin@') ? ADMIN_TOKEN : OWNER_TOKEN;
      return send(200, {
        access_token: who, refresh_token: `${who}-r`,
        user: { id: who, email: String(raw).includes('admin@') ? 'admin@furnishar.ph' : 'owner@furnishar.ph' }
      });
    }

    // is_platform_admin: the server's answer, which the UI must obey.
    if (req.url.startsWith('/rest/v1/rpc/is_platform_admin')) return send(200, isAdmin(req));

    if (req.url.startsWith('/rest/v1/rpc/applicant_account')) {
      if (!isAdmin(req)) return send(403, { message: 'Only a platform administrator may look up applicants' });
      let application = null;
      try { application = JSON.parse(raw || '{}').application; } catch { /* ignore */ }
      if (application === 'app-stuck') {
        return send(200, { found: true, confirmed: false, confirmed_at: null, last_sign_in_at: null, disabled: false });
      }
      return send(200, {
        found: true, confirmed: true,
        confirmed_at: new Date(Date.now() - 7200e3).toISOString(),
        last_sign_in_at: new Date(Date.now() - 1800e3).toISOString(),
        disabled: false
      });
    }

    // 0005: bytes uploaded per store. Refuses a non-admin outright, the same
    // as the real function — an empty result would read as "nothing
    // uploaded", not "you may not ask".
    if (req.url.startsWith('/rest/v1/rpc/storage_usage')) {
      if (!isAdmin(req)) return send(403, { message: 'Only a platform administrator may view storage usage' });
      return send(200, [
        { store_id: 's1', store_name: 'S&C Variety Store', store_slug: 'sc-variety', file_count: 1, total_bytes: 31457280 }
      ]);
    }

    // The queue: RLS returns nothing to a non-admin rather than erroring.
    if (req.url.startsWith('/rest/v1/store_applications')) {
      return send(200, isAdmin(req) ? applications : []);
    }
    if (req.url.startsWith('/rest/v1/stores')) {
      return send(200, isAdmin(req)
        ? [{ id: 's1', slug: 'sc-variety', name: 'S&C Variety Store', plan: 'freemium', status: 'active' }]
        : []);
    }
    if (req.url.startsWith('/rest/v1/admin_audit')) return send(200, isAdmin(req) ? audit : []);
    if (req.url.startsWith('/rest/v1/store_members')) {
      if (isAdmin(req) && adminHasStrayMembership) {
        return send(200, [{
          role: 'owner',
          stores: { id: 's-nino', slug: 'nino-nakano', name: 'Nino Nakano Store', plan: 'freemium' }
        }]);
      }
      return send(200, []);
    }

    // Models and listings across every store. RLS (0004) returns these only to
    // an admin — a store owner sees nothing outside their own shop.
    if (req.url.startsWith('/rest/v1/product_assets')) {
      return send(200, isAdmin(req) ? [{
        id: 'pa1', kind: 'glb', object_path: 's1/p1/armchair.glb',
        byte_size: 31457280, mime_type: 'model/gltf-binary',
        created_at: new Date(Date.now() - 86400e3).toISOString(),
        product: { name: 'Cane Back Armchair', slug: 'armchair-cane-back', status: 'published',
                   store: { name: 'S&C Variety Store', slug: 'sc-variety' } }
      }] : []);
    }
    if (req.url.startsWith('/rest/v1/products')) {
      return send(200, isAdmin(req) ? [
        { id: 'p1', name: 'Cane Back Armchair', slug: 'armchair-cane-back', status: 'published',
          store: { name: 'S&C Variety Store', slug: 'sc-variety' }, product_assets: [{ kind: 'glb' }] },
        // No model attached: the console must call this out.
        { id: 'p2', name: 'Unmodelled Side Table', slug: 'side-table', status: 'draft',
          store: { name: 'S&C Variety Store', slug: 'sc-variety' }, product_assets: [] }
      ] : []);
    }

    if (req.url.startsWith('/rest/v1/rpc/approve_store_application')) {
      if (!isAdmin(req)) {
        return send(403, { message: 'Only a platform administrator may decide applications' });
      }
      const { application, store_slug: slug } = JSON.parse(raw || '{}');
      applications = applications.map(a =>
        a.id === application ? { ...a, status: 'approved' } : a);
      audit = [{
        id: 'a1', actor_email: 'admin@furnishar.ph', action: 'application.approved',
        subject: application, detail: { store_name: 'Mindoro Rattan Works', slug },
        at: new Date().toISOString()
      }, ...audit];
      return send(200, { store_id: 's2', slug });
    }
    if (req.url.startsWith('/rest/v1/rpc/reject_store_application')) {
      if (!isAdmin(req)) return send(403, { message: 'Only a platform administrator may decide applications' });
      return send(200, { status: 'rejected' });
    }
    send(200, []);
  });
});

await new Promise(resolve => supabase.listen(SUPABASE_PORT, resolve));

// `next start` on a taken port exits, and the wait loop below would then find
// the stale server answering and test that instead of this build.
if (await fetch(`http://127.0.0.1:${APP_PORT}/admin`).then(() => true).catch(() => false)) {
  console.error(`Something is already listening on ${APP_PORT}. Stop it first.`);
  process.exit(1);
}

// Detached on purpose: `next start` is a launcher, and killing it would leave
// the real next-server child holding the port for the next run.
const app = spawn('npx', ['next', 'start', '-p', String(APP_PORT)], {
  env: {
    ...process.env,
    SUPABASE_URL: `http://127.0.0.1:${SUPABASE_PORT}`,
    SUPABASE_PUBLISHABLE_KEY: KEY,
    FURNISHAR_JWT_SECRET: 'admin-check-secret'
  },
  stdio: 'ignore',
  detached: true
});
const stop = () => { try { process.kill(-app.pid, 'SIGTERM'); } catch { app.kill(); } };

for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://127.0.0.1:${APP_PORT}/admin`)).ok) break; } catch { /* waiting */ }
  await new Promise(r => setTimeout(r, 1000));
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const problems = [];
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(label);
};

async function signIn(page, email) {
  await page.goto(`http://127.0.0.1:${APP_PORT}/portal`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('form.login-form', { timeout: 20000 });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', 'whatever');
  await page.click('form.login-form button[type="submit"]');
  await page.waitForTimeout(2000);
}

console.log('--- the way in ---');
{
  // One entry point, on the store sign-in page. It is visible to everyone on
  // purpose: the page behind it refuses anyone who is not an admin, and a link
  // nobody can see would not be a permission anyway.
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${APP_PORT}/portal`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('form.login-form', { timeout: 20000 });
  const entries = page.locator('.superadmin-entry a');
  check('the store sign-in page offers exactly one superadmin entry', await entries.count() === 1,
    `${await entries.count()} found`);
  check('it leads to the console', (await entries.first().getAttribute('href')) === '/admin');
  await entries.first().click();
  await page.waitForURL('**/admin', { timeout: 10000 }).catch(() => {});
  check('clicking it reaches /admin', page.url().endsWith('/admin'));
  await page.close();
}

console.log('--- a signed-out visitor ---');
{
  // Asked to sign in, rather than silently redirected. The console used to
  // bounce everyone to /portal, which meant the portal's own
  // "Superadmin sign-in →" link led to a page that never asked for
  // credentials — there was no way to sign in as the superadmin at all.
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${APP_PORT}/admin`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const body = await page.locator('body').innerText();
  check('is offered a sign-in form', await page.locator('form.login-form').isVisible());
  check('stays on /admin instead of being bounced', page.url().endsWith('/admin'), page.url());
  check('is never shown the console headings', !/Store applications/i.test(body));
  check('sees no applicant data', !body.includes('rattan@shop.ph') && !body.includes('Mindoro Rattan'));
  await page.close();
}

console.log('--- a store owner (signed in, but not an admin) ---');
{
  const page = await browser.newPage();
  await signIn(page, 'owner@furnishar.ph');
  await page.goto(`http://127.0.0.1:${APP_PORT}/admin`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.waitForTimeout(1000);
  const body = await page.locator('body').innerText();
  // Told plainly, not dumped back into their own dashboard. The silent
  // redirect made following the portal's superadmin link look like it had
  // signed you into the wrong account: you simply reappeared in your shop.
  check('is told this account is not an administrator',
    /not an administrator/i.test(body), body.slice(0, 80).replace(/\n/g, ' '));
  check('stays on /admin rather than reappearing in a store dashboard',
    page.url().endsWith('/admin'), page.url());
  check('is offered a way to sign in as someone else',
    await page.locator('button:has-text("Sign in as someone else")').isVisible());
  check('is never shown the console headings', !/Store applications/i.test(body));
  check('sees no applicant email', !body.includes('rattan@shop.ph'));
  check('sees no applicant phone', !body.includes('+63431234567'));
  check('sees no other store\'s 3D files', !body.includes('armchair.glb') && !body.includes('Cane Back Armchair'));

  // Back in the portal while signed in, no route to the console is offered at
  // all — that link is rendered from the server's is_platform_admin answer.
  // (The quiet link on the signed-out login page is a different thing, and is
  // meant to be visible to everyone.)
  await page.goto(`http://127.0.0.1:${APP_PORT}/portal`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  check('the signed-in portal offers them no console link',
    !(await page.locator('a[href="/admin"]').count()));
  await page.close();
}

console.log('--- signing in AT /admin, which is what the portal link promises ---');
{
  // The gap this covers: /admin had no sign-in form. It inspected whatever
  // session happened to exist and redirected everyone else, so the only way
  // to reach the console was to sign in at /portal first and then navigate —
  // undocumented, and the opposite of what "Superadmin sign-in →" says.
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${APP_PORT}/admin`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('form.login-form', { timeout: 20000 });
  const callsBeforeLogin = calls.length;
  await page.fill('input[name="email"]', 'admin@furnishar.ph');
  await page.fill('input[name="password"]', 'whatever');
  await page.click('form.login-form button[type="submit"]');
  await page.waitForTimeout(3000);
  check('signing in here reaches the console',
    /Overview/i.test(await page.locator('body').innerText()), page.url());

  /* The console is six routes now, and the queue is one of them. Following
     the nav is the check: a sub-nav whose links do not reach their sections
     is the same bug as a burger that does not open. */
  await page.click('.admin-nav-link:has-text("Applications")');
  await page.waitForURL('**/admin/applications', { timeout: 10000 }).catch(() => {});
  await page.waitForSelector('.review-card', { timeout: 20000 }).catch(() => {});
  const body = await page.locator('body').innerText();
  check('the console nav reaches the review queue', /Store applications/i.test(body),
    page.url());
  check('and it is the real queue', body.includes('Mindoro Rattan'));

  // verify() loads the queue once on the way to 'ready', and a second effect
  // reloads it whenever the reviewer switches tabs — keyed on `state`, which
  // also flips to 'ready' on that very same transition. Without a guard the
  // effect fires right alongside verify()'s own load, so the first paint of
  // the console cost two reads of every table instead of one.
  const queueReadsAfterLogin = calls
    .slice(callsBeforeLogin)
    .filter(c => c.url.startsWith('/rest/v1/store_applications')).length;
  check('the queue is read once on first reaching the console, not twice',
    queueReadsAfterLogin === 1, `${queueReadsAfterLogin} read(s)`);
  await page.close();
}

{
  // The same form must NOT let a store owner in, and must not tell them why
  // the address they used is different from the one that would work.
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${APP_PORT}/admin`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('form.login-form', { timeout: 20000 });
  await page.fill('input[name="email"]', 'owner@furnishar.ph');
  await page.fill('input[name="password"]', 'whatever');
  await page.click('form.login-form button[type="submit"]');
  await page.waitForTimeout(3000);
  const body = await page.locator('body').innerText();
  check('a store owner signing in here is refused', !/Store applications/i.test(body));
  check('and sees no applicant data', !body.includes('rattan@shop.ph'));
  await page.close();
}

console.log('--- the superadmin, who owns no store ---');
{
  // An admin is deliberately never a member of anybody's shop, so signing in
  // lands them on the "no store" branch of the portal. That branch used to
  // show them "your store is in review" and nothing else — their own console
  // was rendered further down a path this returns before reaching.
  const page = await browser.newPage();
  await signIn(page, 'admin@furnishar.ph');
  const body = await page.locator('body').innerText();
  check('is not told their store is in review', !/store is in review/i.test(body));
  check('is told what they actually are', /platform operator/i.test(body));
  check('is offered the console from where they land',
    await page.locator('.login-form a[href="/admin"]').count() > 0);
  await page.close();
}

console.log('--- the reported bug: an admin whose account also owns a real store ---');
{
  // Sign in as the superadmin, then click "Store portal" — this is exactly
  // the reported flow. The portal used to decide "operator view or store
  // dashboard" purely on whether a membership row existed, so an admin
  // account that also happened to carry one (from testing, from signing up
  // before being promoted, from anything) fell straight through into that
  // OTHER store's dashboard — the exact bug: "Nino Nakano Store" instead of
  // the platform console.
  adminHasStrayMembership = true;
  const page = await browser.newPage();
  await signIn(page, 'admin@furnishar.ph');
  const body = await page.locator('body').innerText();
  check('is not shown the stray store\'s dashboard',
    !/Nino Nakano/i.test(body) && !/Welcome back/i.test(body));
  check('is told what they actually are, not sent to someone else\'s shop',
    /platform operator/i.test(body));
  check('is offered the console from where they land',
    await page.locator('.login-form a[href="/admin"]').count() > 0);
  await page.close();
  adminHasStrayMembership = false;
}

console.log('--- the superadmin ---');
{
  const page = await browser.newPage();
  await signIn(page, 'admin@furnishar.ph');
  // The queue is its own route now, so it has its own URL to link to.
  await page.goto(`http://127.0.0.1:${APP_PORT}/admin/applications`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.review-card', { timeout: 20000 }).catch(() => {});
  const body = await page.locator('body').innerText();
  check('sees the queue', /Mindoro Rattan Works/.test(body));
  check('sees the details needed to vet them', body.includes('rattan@shop.ph'));
  check('sees whether the applicant proved they own that address',
    /email confirmed/i.test(body));

  console.log('--- the reported bug: an applicant stuck on email confirmation ---');
  {
    const stuckCard = page.locator('.review-card', { hasText: 'Stuck Signup Co' });
    await stuckCard.waitFor({ timeout: 10000 });
    const cardText = await stuckCard.innerText();
    check('says why it cannot be approved, not just that it cannot',
      /email not confirmed/i.test(cardText));
    check('the approve button is actually disabled here, not just unresponsive',
      await stuckCard.locator('button:has-text("Approve")').isDisabled());

    const resend = stuckCard.locator('button:has-text("Resend confirmation email")');
    check('offers a way forward instead of a dead end', await resend.count() > 0);
    await resend.click();
    await stuckCard.locator('text=Sent —').waitFor({ timeout: 10000 });
    check('confirms the email was actually sent', true);
  }

  console.log('--- the 3D files across every store ---');
  // Their own section, reached the way an operator reaches it.
  await page.click('.admin-nav-link:has-text("3D files")');
  await page.waitForURL('**/admin/models', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(600);
  const files = await page.locator('body').innerText();
  check('lists an uploaded model with its store and product',
    /Cane Back Armchair/.test(files) && /S&C Variety Store/.test(files));
  check('shows the file size in something readable', /30 MB/.test(files),
    (files.match(/\d+(\.\d+)? [KMG]B/) || ['none'])[0]);
  check('flags a listing with no model attached',
    /Unmodelled Side Table/.test(files) && /no 3D model/i.test(files));

  console.log('--- storage usage, now that a single file can be 100 MB ---');
  await page.click('.admin-nav-link:has-text("Usage")');
  await page.waitForURL('**/admin/usage', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(600);
  const spend = await page.locator('body').innerText();
  check('shows how much each store has uploaded',
    /S&C Variety Store/.test(spend) && /Usage by store/i.test(spend));

  // Back to the queue to approve one.
  await page.click('.admin-nav-link:has-text("Applications")');
  await page.waitForURL('**/admin/applications', { timeout: 10000 }).catch(() => {});
  await page.waitForSelector('.review-card', { timeout: 20000 }).catch(() => {});

  console.log('--- approving ---');
  // Scoped to this one card: a second pending application (the stuck-signup
  // case above) is on the same page now, with its own — disabled — Approve
  // button, and an unscoped click here would be ambiguous between the two.
  const rattanCard = page.locator('.review-card', { hasText: 'Mindoro Rattan Works' });
  await rattanCard.locator('button:has-text("Approve")').click();
  await page.waitForTimeout(500);
  const confirmText = await rattanCard.locator('.review-confirm').innerText().catch(() => '');
  check('asks for confirmation before granting a public shop',
    /publish furniture/i.test(confirmText), confirmText.slice(0, 60).replace(/\n/g, ' '));

  await rattanCard.locator('button:has-text("Yes, approve")').click();
  await page.waitForTimeout(2500);
  const after = await page.locator('body').innerText();
  check('reports the approval', /approved/i.test(after));

  /* The log is its own section now, so the proof moves with it. The decision
     and the record of it are written in one database transaction, so if the
     approval reported above is real this entry must exist. */
  await page.click('.admin-nav-link:has-text("Activity")');
  await page.waitForURL('**/admin/activity', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(800);
  check('records who did it in the activity log',
    /admin@furnishar\.ph/.test(await page.locator('body').innerText()));
  await page.close();
}

console.log('--- signing out, then pressing Back onto the console ---');
{
  // The reported case: read the queue, sign out, and try to walk back into it.
  // The queue holds applicants' email addresses and phone numbers, so a shared
  // or borrowed phone must not hand them to whoever picks it up next.
  const page = await browser.newPage();
  await signIn(page, 'admin@furnishar.ph');
  // The queue is its own route now, so it has its own URL to link to.
  await page.goto(`http://127.0.0.1:${APP_PORT}/admin/applications`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.review-card', { timeout: 20000 }).catch(() => {});
  /* Not rattan@shop.ph: an earlier block approved that application, and the
     queue opens on "Awaiting review", so it is legitimately no longer there.
     The stuck applicant is still pending and proves the same point — an
     admin could read an applicant's contact details. */
  check('the admin could read the queue to begin with',
    (await page.locator('body').innerText()).includes('stuck@shop.ph'));

  await page.goto(`http://127.0.0.1:${APP_PORT}/portal`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.click('button:has-text("Sign out")').catch(() => {});
  await page.waitForTimeout(1500);

  await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(3000);
  const afterBack = await page.locator('body').innerText();
  check('Back after signing out shows no applicant email', !afterBack.includes('stuck@shop.ph'));
  check('Back after signing out shows no applicant phone', !afterBack.includes('+63439998888'));
  check('Back after signing out shows no console headings', !/Store applications/i.test(afterBack));
  await page.close();
}

console.log('--- what the server was actually asked ---');
{
  // Nobody is admitted on a client-side guess: every signed-in visitor asked
  // the server, and took no for an answer. (A signed-out visitor is refused
  // without a round trip — there is no session to ask about.)
  const asked = calls.filter(c => c.url.includes('is_platform_admin'));
  check('each signed-in visitor asked the server whether they are an admin',
    asked.length >= 2, `${asked.length} call(s)`);
  check('the server was asked as a non-admin at least once, and said no',
    asked.some(c => !c.admin));

  const queueReads = calls.filter(c => c.url.startsWith('/rest/v1/store_applications'));
  const nonAdminReads = queueReads.filter(c => !c.admin);
  check('the queue was never even requested by a non-admin',
    queueReads.length > 0 && nonAdminReads.length === 0,
    `${queueReads.length} read(s), ${nonAdminReads.length} of them non-admin`);

  const approvals = calls.filter(c => c.url.includes('approve_store_application'));
  check('approval was only ever called by the admin',
    approvals.length > 0 && approvals.every(c => c.admin));
}

await browser.close();
stop();
supabase.close();

console.log(problems.length ? `\nFAILED: ${problems.join('; ')}` : '\nall admin portal checks passed');
process.exit(problems.length ? 1 : 0);
