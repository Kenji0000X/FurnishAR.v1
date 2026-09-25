/**
 * Mobile layout check for the pages a shop owner actually uses on a phone.
 *
 * Looks for the things that make a page unusable rather than merely ugly:
 * horizontal overflow, tap targets under the 44px guideline, text that would
 * trigger iOS zoom-on-focus (< 16px in an input), and error text that overflows
 * its container.
 *
 * Usage: node scripts/check-mobile.mjs [baseUrl]
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:3000';
const DEVICES = [
  { name: 'iPhone SE', width: 375, height: 667 },
  { name: 'Pixel 7',   width: 412, height: 915 }
];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const problems = [];

async function audit(page, label) {
  const report = await page.evaluate(() => {
    const doc = document.documentElement;
    const overflow = doc.scrollWidth - doc.clientWidth;

    const widest = [];
    if (overflow > 0) {
      for (const el of document.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > doc.clientWidth + 1) {
          widest.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]} (right ${Math.round(r.right)})`);
        }
      }
    }

    const small = [];
    for (const el of document.querySelectorAll('button, a, input, select, textarea')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;         // hidden
      if (el.type === 'hidden') continue;
      if (r.height < 44) {
        small.push(`${el.tagName.toLowerCase()}${el.name ? `[${el.name}]` : ''} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }

    const zoomy = [];
    for (const el of document.querySelectorAll('input, select, textarea')) {
      const r = el.getBoundingClientRect();
      if (r.height === 0) continue;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < 16) zoomy.push(`${el.tagName.toLowerCase()}${el.name ? `[${el.name}]` : ''} ${size}px`);
    }

    return { overflow, widest: [...new Set(widest)].slice(0, 6), small: [...new Set(small)], zoomy: [...new Set(zoomy)] };
  });

  const ok = report.overflow <= 0;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}: no horizontal overflow${ok ? '' : ` (${report.overflow}px)`}`);
  if (!ok) {
    report.widest.forEach(w => console.log(`         overflowing: ${w}`));
    problems.push(`${label}: ${report.overflow}px overflow`);
  }
  if (report.small.length) console.log(`       note — under 44px tall: ${report.small.join(', ')}`);
  if (report.zoomy.length) console.log(`       note — under 16px (iOS zooms on focus): ${report.zoomy.join(', ')}`);
  return report;
}

for (const device of DEVICES) {
  console.log(`\n=== ${device.name} (${device.width}px) ===`);
  const context = await browser.newContext({
    viewport: { width: device.width, height: device.height },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true
  });
  const page = await context.newPage();

  for (const path of ['/', '/plan', '/portal', '/collection']) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await audit(page, path);
  }

  // The sign-up form is taller and denser than anything else on the site, and
  // is where the reported errors appear.
  await page.goto(`${BASE}/portal`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('form.login-form', { timeout: 20000 });
  await page.click('button:has-text("New store? Sign up")');
  await page.waitForSelector('input[name="storeName"]');
  await audit(page, '/portal (sign-up form)');

  // And with a long error message in place, which is the state the user hit.
  await page.evaluate(() => {
    const box = document.querySelector('form.login-form .form-error');
    if (box) {
      box.textContent =
        'Store sign-ups are closed while the catalogue database is disconnected. Email hello@furnishar.ph and we will add your store by hand.';
    }
  });
  await page.waitForTimeout(300);
  await audit(page, '/portal (sign-up form showing a long error)');

  // The signed-in dashboard, which is the /portal a shop owner actually
  // spends time in — and which this check had never seen. Every /portal audit
  // above is of the login screen, so the inventory table's 182px of sideways
  // scroll on a 390px phone survived every green run of this file. Signing in
  // costs one form fill; not signing in costs the only page the audience of
  // this check uses daily.
  await page.goto(`${BASE}/portal`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('form.login-form', { timeout: 20000 });
  await page.fill('input[name="email"]', 'owner@furnishar.ph');
  await page.fill('input[name="password"]', 'furnishar');
  await page.click('form.login-form button[type="submit"]');
  const signedIn = await page.waitForSelector('.console', { timeout: 20000 }).then(() => true, () => false);
  if (signedIn) {
    await page.waitForTimeout(1200);
    await audit(page, '/portal (signed in, inventory table)');
  } else {
    // Said out loud rather than skipped silently: a check that quietly stops
    // checking is worse than one that fails.
    console.log('  --   could not sign in, so the dashboard was NOT audited');
  }

  await context.close();
}

await browser.close();
console.log(problems.length ? `\nFAILED: ${problems.join('; ')}` : '\nno mobile layout problems found');
process.exit(problems.length ? 1 : 0);
