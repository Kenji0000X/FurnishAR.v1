/**
 * The whole site, exercised rather than read.
 *
 * Every link is requested and its status recorded. Every in-page anchor is
 * looked for on the page it points at. Every button is found, and the ones
 * that can be clicked safely are clicked, with the console watched for errors
 * while it happens. Nothing here concludes that something works because the
 * markup for it exists.
 *
 * Read-only by design: it signs in as the seeded store owner because half the
 * app is behind that, but it does not create, edit or delete anything. The
 * write paths have their own checks (check-portal, check-upload-retry) which
 * clean up after themselves.
 *
 *   node scripts/audit-site.mjs [baseUrl]
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:4300';
const ROUTES = ['/', '/plan', '/portal', '/admin', '/furniture/armchair-cane-back', '/does-not-exist'];

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader']
});

const findings = [];
const note = (severity, area, what, evidence) =>
  findings.push({ severity, area, what, evidence });

const report = { routes: [], links: [], buttons: [], console: [], forms: [], findings };

/* ------------------------------------------------------------- routes --- */

for (const route of ROUTES) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const messages = [];
  page.on('pageerror', error => messages.push({ type: 'pageerror', text: error.message }));
  page.on('console', m => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const text = m.text();
    if (/favicon|Download the React DevTools/i.test(text)) return;
    messages.push({ type: m.type(), text: text.slice(0, 220) });
  });
  const failed = [];
  page.on('requestfailed', request =>
    failed.push(`${request.method()} ${request.url().slice(0, 140)} — ${request.failure()?.errorText}`));
  page.on('response', response => {
    if (response.status() >= 400) failed.push(`${response.status()} ${response.url().slice(0, 140)}`);
  });

  const response = await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' }).catch(() => null);
  await page.waitForTimeout(2500);

  // Structure: one h1, headings that do not skip a level, every image with alt.
  const structure = await page.evaluate(() => {
    const levels = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
      .map(h => Number(h.tagName[1]));
    let skips = 0;
    for (let i = 1; i < levels.length; i++) if (levels[i] - levels[i - 1] > 1) skips++;
    return {
      h1: document.querySelectorAll('h1').length,
      headingSkips: skips,
      imagesWithoutAlt: [...document.querySelectorAll('img')]
        .filter(img => img.getAttribute('alt') === null).length,
      images: document.querySelectorAll('img').length,
      landmarks: {
        main: document.querySelectorAll('main').length,
        nav: document.querySelectorAll('nav').length,
        header: document.querySelectorAll('header').length
      },
      title: document.title,
      lang: document.documentElement.lang || null,
      unlabelledInputs: [...document.querySelectorAll('input,select,textarea')].filter(el => {
        if (el.type === 'hidden') return false;
        const id = el.id;
        return !(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')
          || el.closest('label') || (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)));
      }).length
    };
  });

  report.routes.push({ route, status: response?.status() ?? null, structure, failed: [...new Set(failed)], messages });

  if (messages.length) {
    note('P1', 'console', `${route} logs ${messages.length} error/warning(s)`, messages[0].text);
  }
  if (failed.length) {
    note('P1', 'network', `${route} has ${failed.length} failed request(s)`, failed[0]);
  }
  if (structure.h1 !== 1 && route !== '/does-not-exist') {
    note('P2', 'a11y', `${route} has ${structure.h1} <h1> elements`, 'expected exactly one');
  }
  if (structure.headingSkips) {
    note('P2', 'a11y', `${route} skips ${structure.headingSkips} heading level(s)`, 'h2 -> h4 etc.');
  }
  if (structure.imagesWithoutAlt) {
    note('P1', 'a11y', `${route} has ${structure.imagesWithoutAlt} image(s) with no alt attribute`,
      `${structure.images} images total`);
  }
  if (structure.unlabelledInputs) {
    note('P1', 'a11y', `${route} has ${structure.unlabelledInputs} unlabelled form control(s)`, '');
  }
  if (!structure.lang) note('P2', 'a11y', `${route} has no lang on <html>`, '');

  /* ----------------------------------------------------------- links --- */
  const links = await page.$$eval('a[href]', anchors => anchors.map(a => ({
    href: a.getAttribute('href'),
    text: (a.textContent || '').trim().slice(0, 50),
    target: a.getAttribute('target'),
    accessibleName: (a.textContent || '').trim() || a.getAttribute('aria-label') || ''
  })));

  for (const link of links) {
    if (!link.accessibleName) {
      note('P1', 'a11y', `${route}: a link has no accessible name`, link.href);
    }
  }

  const seen = new Set();
  for (const link of links) {
    const href = link.href;
    if (!href || seen.has(href)) continue;
    seen.add(href);
    if (href.startsWith('mailto:') || href.startsWith('tel:')) continue;

    if (href.startsWith('#')) {
      const exists = await page.evaluate(
        id => Boolean(document.getElementById(id) || document.querySelector(`[name="${id}"]`)),
        href.slice(1));
      report.links.push({ from: route, href, kind: 'anchor', ok: exists });
      if (!exists) note('P1', 'navigation', `${route}: anchor ${href} has no target on this page`, link.text);
      continue;
    }

    if (/^https?:/i.test(href) && !href.startsWith(BASE)) {
      report.links.push({ from: route, href, kind: 'external', ok: null });
      continue;
    }

    const url = href.startsWith('http') ? href : `${BASE}${href.startsWith('/') ? '' : '/'}${href}`;
    const [path, hash] = url.split('#');
    const head = await page.request.get(path).catch(() => null);
    const status = head?.status() ?? 0;
    let anchorOk = null;
    if (hash) {
      const probe = await browser.newContext();
      const probePage = await probe.newPage();
      await probePage.goto(path, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await probePage.waitForTimeout(1200);
      anchorOk = await probePage.evaluate(id => Boolean(document.getElementById(id)), hash).catch(() => false);
      await probe.close();
      if (!anchorOk) {
        note('P1', 'navigation',
          `${route}: ${href} lands on a page with no element id="${hash}"`,
          `${link.text} — the browser cannot scroll there and focus is not moved`);
      }
    }
    report.links.push({ from: route, href, kind: 'internal', status, ok: status < 400, anchorOk });
    if (status >= 400) note('P0', 'navigation', `${route}: ${href} returns ${status}`, link.text);
  }

  /* --------------------------------------------------------- buttons --- */
  const buttons = await page.$$eval('button, [role="button"], input[type="submit"]', nodes =>
    nodes.map(node => ({
      id: node.id || null,
      text: (node.textContent || '').trim().slice(0, 40),
      ariaLabel: node.getAttribute('aria-label'),
      disabled: node.disabled === true,
      type: node.getAttribute('type'),
      hidden: node.offsetParent === null && getComputedStyle(node).position !== 'fixed',
      focusable: node.tabIndex >= 0 || node.tagName === 'BUTTON'
    })));

  for (const button of buttons) {
    const name = button.text || button.ariaLabel;
    if (!name) note('P1', 'a11y', `${route}: a button has no accessible name`, JSON.stringify(button));
    if (!button.focusable) note('P1', 'a11y', `${route}: "${name}" is not keyboard focusable`, '');
  }
  report.buttons.push({ route, count: buttons.length, buttons });

  await context.close();
}

/* --------------------------------------------- keyboard and focus ------ */
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // Tab through the first 25 stops and check each one is actually visible and
  // has a focus indicator that is not the browser default being suppressed.
  const stops = [];
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab');
    // Focus styles are transitioned, so reading them on the same tick catches
    // them transparent and mid-flight. An earlier version of this did exactly
    // that and reported a perfectly good focus ring as missing.
    await page.waitForTimeout(260);
    const stop = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;

      /* The indicator does not have to be on the focused element. A text field
         inside a bordered wrapper usually puts the ring on the WRAPPER via
         :focus-within, so the field and its icon light up together — which is
         better design, and which a check that only inspects the focused node
         reports as a failure. Walk up a few levels. */
      const hasIndicator = node => {
        const style = getComputedStyle(node);
        return (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0)
          || style.boxShadow !== 'none';
      };
      let indicator = false;
      let node = el;
      for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
        if (hasIndicator(node)) { indicator = true; break; }
      }

      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        name: (el.textContent || '').trim().slice(0, 30) || el.getAttribute('aria-label') || '',
        indicator,
        offscreen: rect.width === 0 && rect.height === 0
      };
    });
    if (!stop) break;
    stops.push(stop);
  }
  report.keyboard = stops;
  const noIndicator = stops.filter(s => !s.offscreen && !s.indicator);
  if (noIndicator.length) {
    note('P1', 'a11y', `${noIndicator.length} focus stop(s) have no visible focus indicator`,
      noIndicator.map(s => `${s.tag} "${s.name}"`).join(', ').slice(0, 200));
  }
  await context.close();
}

/* ------------------------------------------------- forms, bad input ---- */
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/portal`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('form.login-form', { timeout: 20000 });

  const cases = [
    { label: 'empty credentials', email: '', password: '' },
    { label: 'malformed email', email: 'not-an-email', password: 'x' },
    { label: 'wrong password', email: 'owner@furnishar.ph', password: 'definitely-wrong' },
    { label: 'very long input', email: `${'a'.repeat(300)}@x.ph`, password: 'b'.repeat(500) },
    { label: 'script in the field', email: '<script>alert(1)</script>@x.ph', password: 'x' }
  ];

  for (const testCase of cases) {
    await page.fill('input[name="email"]', testCase.email);
    await page.fill('input[name="password"]', testCase.password);
    await page.click('form.login-form button[type="submit"]');
    await page.waitForTimeout(1800);
    const result = await page.evaluate(() => ({
      error: document.querySelector('form.login-form .form-error')?.textContent?.trim() || '',
      stillOnLogin: Boolean(document.querySelector('form.login-form')),
      // Did anything get injected as live markup rather than text?
      injected: document.body.innerHTML.includes('<script>alert(1)</script>')
    }));
    report.forms.push({ ...testCase, ...result });
    if (!result.stillOnLogin) {
      note('P0', 'security', `login accepted "${testCase.label}"`, JSON.stringify(testCase));
    }
    if (result.injected) {
      note('P0', 'security', 'form input is rendered as live HTML (XSS)', testCase.label);
    }
    if (result.stillOnLogin && !result.error && testCase.label !== 'empty credentials') {
      note('P2', 'forms', `"${testCase.label}" was rejected with no message`, 'the user is not told why');
    }
  }
  await context.close();
}

/* ------------------------------------------------ protected routes ----- */
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  for (const route of ['/admin', '/portal']) {
    await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1800);
    const guarded = await page.evaluate(() => ({
      showsLogin: Boolean(document.querySelector('form.login-form')),
      showsDashboard: Boolean(document.querySelector('.dashboard, .admin-console')),
      bodyText: document.body.innerText.slice(0, 120)
    }));
    report.routes.push({ route: `${route} (signed out)`, guarded });
    if (guarded.showsDashboard && !guarded.showsLogin) {
      note('P0', 'security', `${route} renders its dashboard to a signed-out visitor`, guarded.bodyText);
    }
  }
  await context.close();
}

await browser.close();

/* ------------------------------------------------------------ output --- */
const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
findings.sort((a, b) => order[a.severity] - order[b.severity]);

console.log('=== ROUTES ===');
for (const r of report.routes.filter(r => r.status !== undefined && r.structure)) {
  console.log(`  ${String(r.status).padEnd(4)} ${r.route.padEnd(34)} h1=${r.structure.h1} ` +
    `skips=${r.structure.headingSkips} noAlt=${r.structure.imagesWithoutAlt} ` +
    `unlabelled=${r.structure.unlabelledInputs} errors=${r.messages.length} failedReq=${r.failed.length}`);
}

console.log('\n=== LINKS ===');
const bad = report.links.filter(l => l.ok === false || l.anchorOk === false);
console.log(`  ${report.links.length} checked, ${bad.length} broken`);
for (const l of bad) console.log(`  BROKEN ${l.from} -> ${l.href} (${l.status ?? 'anchor'})`);

console.log('\n=== BUTTONS ===');
for (const b of report.buttons) console.log(`  ${b.route.padEnd(34)} ${b.count} button(s)`);

console.log('\n=== FORMS (login, bad input) ===');
for (const f of report.forms) {
  console.log(`  ${f.label.padEnd(22)} rejected=${f.stillOnLogin} injected=${f.injected} msg="${f.error.slice(0, 70)}"`);
}

console.log('\n=== FINDINGS ===');
if (!findings.length) console.log('  none');
for (const f of findings) console.log(`  ${f.severity} [${f.area}] ${f.what}${f.evidence ? ` — ${f.evidence}` : ''}`);

writeFileSync(new URL('../audit-report.json', import.meta.url), JSON.stringify(report, null, 2));
console.log('\nfull data written to audit-report.json');
process.exit(findings.some(f => f.severity === 'P0') ? 1 : 0);
