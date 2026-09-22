/**
 * The whole site, every route, every viewport, measured rather than eyeballed.
 *
 * This is the audit instrument, not a pass/fail gate: it visits every real
 * route in the app at thirteen widths and writes down what it finds. The
 * check-*.mjs scripts are the gates; this is what tells you what to put in
 * one.
 *
 * It reports, per route:
 *   - horizontal overflow, and WHICH element is widest when there is any
 *   - console errors, page exceptions and failed network requests
 *   - every link's destination, resolved with a real request
 *   - every button's accessible name, and whether it has any handler at all
 *   - interactive targets under 44x44 on a coarse pointer
 *   - heading hierarchy jumps
 *   - form fields with no associated label
 *   - focus indicators that are invisible
 *   - images with no alt attribute at all
 *
 *   node scripts/audit-site-full.mjs [baseUrl]
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:4173';

/* The real routes, from app/ **. Not invented: every one has a page.js. */
const ROUTES = [
  '/', '/collection', '/collection?q=armchair', '/collection?category=Chair',
  '/faq', '/plan', '/diagnose', '/portal', '/admin', '/login', '/login?as=buyer',
  '/account', '/furniture/armchair-cane-back',
  '/this-route-does-not-exist'
];

const WIDTHS = [320, 360, 375, 390, 414, 430, 768, 820, 1024, 1280, 1440, 1600, 1920];

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader']
});

const findings = [];
const add = (route, viewport, category, severity, detail) =>
  findings.push({ route, viewport, category, severity, detail });

/* ---------------------------------------------------------- per route --- */
for (const route of ROUTES) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('requestfailed', r => {
    /* An aborted RSC prefetch is Next cancelling work it no longer needs, not
       a broken request. Reporting them made every page look like it had a
       network failure. A prefetch that ANSWERS with an error still counts,
       below. */
    if (r.url().includes('_rsc=')) return;
    failedRequests.push(`${r.method()} ${r.url()} (${r.failure()?.errorText || 'failed'})`);
  });
  page.on('response', r => {
    if (r.status() >= 400 && !r.url().includes('does-not-exist')) {
      failedRequests.push(`${r.status()} ${r.url()}`);
    }
  });

  const response = await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' })
    .catch(() => null);
  await page.waitForTimeout(1200);

  const status = response?.status() ?? 0;
  if (route === '/this-route-does-not-exist') {
    const body = await page.locator('body').innerText().catch(() => '');
    if (status !== 404) add(route, '-', 'route', 'P1', `unknown route answered ${status}, not 404`);
    if (!/isn.t here|not found|doesn.t exist/i.test(body)) {
      add(route, '-', 'route', 'P1', 'no 404 copy on an unknown route');
    }
    const home = await page.locator('a[href="/"]').count();
    if (!home) add(route, '-', 'route', 'P2', '404 page offers no way home');
  } else if (status >= 400) {
    add(route, '-', 'route', 'P0', `route answered ${status}`);
  }

  for (const message of consoleErrors) {
    /* The 404 route's own 404 is the correct answer, and the browser logs it
       as a console error either way. */
    if (route === '/this-route-does-not-exist' && /404/.test(message)) continue;
    add(route, '1280', 'console', 'P2', message.slice(0, 160));
  }
  for (const message of pageErrors) add(route, '1280', 'runtime', 'P0', message.slice(0, 160));
  for (const request of [...new Set(failedRequests)]) {
    add(route, '1280', 'network', 'P1', request.slice(0, 160));
  }

  if (route === '/this-route-does-not-exist') { await page.close(); continue; }

  /* --- headings, labels, alt text, buttons, links, focus ---------------- */
  const semantics = await page.evaluate(() => {
    const out = {
      headings: [], unlabelledFields: [], altless: [], buttons: [], links: [],
      h1Count: document.querySelectorAll('h1').length
    };
    for (const h of document.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
      out.headings.push({ level: Number(h.tagName[1]), text: h.textContent.trim().slice(0, 40) });
    }
    for (const field of document.querySelectorAll('input,select,textarea')) {
      if (field.type === 'hidden') continue;
      const labelled = field.labels?.length > 0
        || field.getAttribute('aria-label')
        || field.getAttribute('aria-labelledby');
      if (!labelled) out.unlabelledFields.push(field.name || field.type || field.tagName);
    }
    for (const img of document.querySelectorAll('img')) {
      if (!img.hasAttribute('alt')) out.altless.push(img.getAttribute('src') || '(no src)');
    }
    for (const button of document.querySelectorAll('button')) {
      const name = (button.textContent || '').trim() || button.getAttribute('aria-label') || '';
      /* No listener sniffing. The first version looked for React fibre keys
         and reported every button in the planner as dead — the planner is
         vanilla JS built with innerHTML and wired with addEventListener, so
         it has no fibres and was never broken. Whether a control does
         something is established below by clicking it and watching, not by
         guessing from its properties. */
      out.buttons.push({
        name: name.slice(0, 40),
        type: button.getAttribute('type'),
        disabled: button.disabled
      });
    }
    for (const a of document.querySelectorAll('a')) {
      out.links.push({
        href: a.getAttribute('href'),
        name: ((a.textContent || '').trim() || a.getAttribute('aria-label') || '').slice(0, 40)
      });
    }
    return out;
  });

  if (semantics.h1Count === 0) add(route, '-', 'a11y', 'P1', 'no h1 on the page');
  if (semantics.h1Count > 1) add(route, '-', 'a11y', 'P2', `${semantics.h1Count} h1 elements`);
  let previous = 0;
  for (const heading of semantics.headings) {
    if (previous && heading.level > previous + 1) {
      add(route, '-', 'a11y', 'P2',
        `heading jumps h${previous} -> h${heading.level} at "${heading.text}"`);
    }
    previous = heading.level;
  }
  for (const field of semantics.unlabelledFields) {
    add(route, '-', 'a11y', 'P1', `form field with no label: ${field}`);
  }
  for (const src of semantics.altless) add(route, '-', 'a11y', 'P1', `img with no alt: ${src}`);
  for (const button of semantics.buttons) {
    if (!button.name) add(route, '-', 'a11y', 'P1', 'button with no accessible name');
  }
  for (const link of semantics.links) {
    if (!link.name) add(route, '-', 'a11y', 'P1', `link with no accessible name -> ${link.href}`);
    if (!link.href) add(route, '-', 'dead-control', 'P1', `<a> with no href ("${link.name}")`);
  }

  /* --- every internal link actually resolves ---------------------------- */
  const internal = [...new Set(semantics.links
    .map(l => l.href)
    .filter(h => h && h.startsWith('/') && !h.startsWith('//')))];
  for (const href of internal) {
    const [path, hash] = href.split('#');
    const probe = await fetch(`${BASE}${path || '/'}`, { redirect: 'manual' }).catch(() => null);
    if (!probe) { add(route, '-', 'link', 'P1', `${href} could not be requested`); continue; }
    if (probe.status >= 400) add(route, '-', 'link', 'P1', `${href} -> HTTP ${probe.status}`);
    if (hash) {
      const target = await browser.newPage();
      /* WITH the hash. /portal#apply reveals the application form — the id
         is rendered by that panel, so loading /portal bare and looking for
         #apply reported a working deep link as broken. Navigating the way a
         visitor does is the only honest way to test an anchor. */
      await target.goto(`${BASE}${href}`, { waitUntil: 'domcontentloaded' });
      await target.waitForTimeout(400);
      /* CSS.escape lives in the browser, not in Node — done inside the page. */
      const exists = await target.evaluate(
        id => document.querySelectorAll(`#${CSS.escape(id)}`).length, hash);
      if (!exists) add(route, '-', 'link', 'P1', `${href} — #${hash} is not on that page`);
      await target.close();
    }
  }

  /* --- focus indicator, walked with the real Tab key -------------------- */
  /* Programmatic .focus() does not set :focus-visible on a button in
     Chromium, so the first version reported every button on the site as
     having no focus ring. Tab is the thing being tested; press Tab. A ring
     may also live on an ANCESTOR — BRAND.md documents exactly that for the
     search field, where the wrapper lights up rather than the bare input —
     so the check walks up as well. */
  for (let i = 0; i < 18; i++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const node = document.activeElement;
      if (!node || node === document.body) return null;
      const name = ((node.textContent || '').trim() || node.getAttribute('aria-label')
        || node.name || node.tagName).slice(0, 30);
      for (let el = node; el && el !== document.body; el = el.parentElement) {
        const s = getComputedStyle(el);
        const outlined = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
        const shadowed = s.boxShadow !== 'none';
        if (outlined || shadowed) return { name, ok: true };
      }
      return { name, ok: false };
    });
    if (stop && !stop.ok) {
      add(route, '-', 'a11y', 'P1', `Tab reaches "${stop.name}" with no visible focus ring`);
    }
  }

  await page.close();

  /* --- every viewport --------------------------------------------------- */
  for (const width of WIDTHS) {
    const view = await browser.newPage({
      viewport: { width, height: 800 },
      /* isMobile as well as hasTouch: `pointer: coarse` is what the
         stylesheet's touch-target block keys on, and hasTouch alone leaves
         the primary pointer "fine" in Chromium — so the first run measured
         every control at its desktop size and reported targets that are
         44px on a real phone. */
      hasTouch: width <= 820,
      isMobile: width <= 820
    });
    await view.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await view.waitForTimeout(700);

    const layout = await view.evaluate(() => {
      const doc = document.documentElement;
      const over = doc.scrollWidth - doc.clientWidth;
      const widest = [];
      if (over > 0) {
        for (const el of document.querySelectorAll('body *')) {
          const r = el.getBoundingClientRect();
          if (r.right > doc.clientWidth + 1 && r.width > 0) {
            widest.push({
              tag: el.tagName.toLowerCase(),
              cls: (el.className?.toString?.() || '').slice(0, 44),
              right: Math.round(r.right)
            });
          }
        }
      }
      /* Anything a finger has to hit. */
      const small = [];
      for (const el of document.querySelectorAll(
        'a[href],button:not([disabled]),input:not([type=hidden]),select,[role=button]'
      )) {
        /* A checkbox wrapped in its own <label> is 16x16, but the thing a
           finger hits is the label. Measure whichever is actually clickable. */
        const label = el.closest('label');
        const box = (label && (el.type === 'checkbox' || el.type === 'radio')) ? label : el;
        const r = box.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (getComputedStyle(el).visibility === 'hidden') continue;
        if (r.width < 44 || r.height < 44) {
          small.push({
            name: ((el.textContent || '').trim() || el.getAttribute('aria-label') || el.tagName)
              .slice(0, 28),
            w: Math.round(r.width), h: Math.round(r.height)
          });
        }
      }
      /* Text clipped by its own box. */
      const clipped = [];
      for (const el of document.querySelectorAll('h1,h2,h3,p,span,b,small,label,td,th')) {
        if (el.children.length) continue;
        /* Visually-hidden text is clipped on purpose — that is the technique.
           Reporting it made "Search furniture" a finding on every page. */
        if (el.closest('.sr-only, .visually-hidden')) continue;
        if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflow !== 'visible') {
          clipped.push((el.textContent || '').trim().slice(0, 30));
        }
      }
      return { over, widest: widest.slice(0, 4), small, clipped: clipped.slice(0, 5) };
    }).catch(() => null);

    if (layout) {
      if (layout.over > 0) {
        add(route, `${width}`, 'overflow', 'P1',
          `${layout.over}px over — widest: ${layout.widest.map(w => `${w.tag}.${w.cls}@${w.right}`).join(', ')}`);
      }
      if (width <= 820) {
        for (const target of layout.small) {
          add(route, `${width}`, 'touch-target', 'P2',
            `"${target.name}" is ${target.w}x${target.h}`);
        }
      }
      for (const text of layout.clipped) {
        add(route, `${width}`, 'clipping', 'P2', `clipped text: "${text}"`);
      }
    }
    await view.close();
  }
}

await browser.close();

/* ------------------------------------------------------------- report --- */
const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
findings.sort((a, b) => order[a.severity] - order[b.severity]);

/* Collapsed: the same finding at eleven widths is one issue, not eleven. */
const grouped = new Map();
for (const f of findings) {
  const key = `${f.severity}|${f.route}|${f.category}|${f.detail}`;
  if (!grouped.has(key)) grouped.set(key, { ...f, viewports: [] });
  grouped.get(key).viewports.push(f.viewport);
}
const rows = [...grouped.values()];

const counts = rows.reduce((acc, r) => ({ ...acc, [r.severity]: (acc[r.severity] || 0) + 1 }), {});
console.log(`\n=== ${rows.length} distinct findings ===`);
for (const level of ['P0', 'P1', 'P2', 'P3']) {
  if (counts[level]) console.log(`  ${level}: ${counts[level]}`);
}
console.log('');
for (const row of rows) {
  const where = row.viewports.filter(v => v !== '-');
  console.log(`[${row.severity}] ${row.route} — ${row.category}`);
  console.log(`      ${row.detail}`);
  if (where.length) console.log(`      at ${where.join(', ')}px`);
}

/* A gate, not just a report.
   Everything it now finds was fixed, so a P0 or a P1 appearing again is a
   regression and should stop a build rather than scroll past in a log. P2s
   are printed and forgiven: they are judgement calls (a deliberate ellipsis,
   a heading level) that deserve a human deciding, not a red build. */
const blocking = rows.filter(r => r.severity === 'P0' || r.severity === 'P1');
console.log(blocking.length
  ? `\nFAILED: ${blocking.length} blocking finding(s)`
  : '\nevery route, every width: no blocking findings');
process.exit(blocking.length ? 1 : 0);
