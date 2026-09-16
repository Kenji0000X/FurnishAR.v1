/**
 * Drives the owner portal end to end against a running server.
 *
 * The portal is the one part of the app that writes, so a green build proves
 * very little: this signs in, adds a product, edits it, and deletes it, and
 * fails loudly if any step does not land.
 *
 * Usage: node scripts/check-portal.mjs [baseUrl]
 * Needs a writable catalogue, so run it against `next start` locally, never
 * against production.
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:4173';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();

const problems = [];
const errors = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => {
  const text = m.text();
  // /portal prefetches are fine; anything else is worth seeing.
  if (m.type() === 'error' && !text.includes('favicon')) errors.push(`console: ${text}`);
});

const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(label);
};

await page.goto(`${BASE}/portal`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('form.login-form', { timeout: 20000 });
console.log('--- sign in ---');

await page.fill('input[name="email"]', 'owner@furnishar.ph');
await page.fill('input[name="password"]', 'furnishar');
await page.click('form.login-form button[type="submit"]');
await page.waitForSelector('.dashboard', { timeout: 20000 }).catch(() => {});
check('dashboard appears after sign-in', await page.locator('.dashboard').isVisible());
check(
  'store name is shown',
  (await page.locator('.dashboard-top .eyebrow').textContent().catch(() => '') || '').includes('Variety')
);

const rowsBefore = await page.locator('.inventory-table-wrap tbody tr').count();
console.log(`  (${rowsBefore} row(s) before)`);

console.log('--- add a product ---');
const NAME = `Check Bench ${Date.now()}`;
await page.click('button:has-text("+ Add product")');
await page.waitForSelector('dialog.form-dialog[open]', { timeout: 10000 });
await page.fill('input[name="name"]', NAME);
await page.fill('input[name="price"]', '1234');
await page.fill('input[name="stock"]', '3');
await page.fill('input[name="width"]', '120');
await page.fill('input[name="height"]', '45');
await page.fill('input[name="depth"]', '40');
await page.click('dialog.form-dialog button[type="submit"]');
await page.waitForTimeout(2500);

const formError = (await page.locator('dialog.form-dialog .form-error').textContent().catch(() => '')) || '';
check('the form reported no error', !formError.trim(), formError.trim());
check('the dialog closed', !(await page.locator('dialog.form-dialog[open]').count()));
check('the new product is in the table', await page.locator(`text=${NAME}`).count() > 0);

console.log('--- edit it ---');
const row = page.locator('tr', { hasText: NAME });
await row.locator('button:has-text("Edit")').click();
await page.waitForSelector('dialog.form-dialog[open]', { timeout: 10000 });
const prefilled = await page.inputValue('input[name="name"]');
check('the edit form is pre-filled', prefilled === NAME, `got "${prefilled}"`);
await page.fill('input[name="stock"]', '9');
await page.click('dialog.form-dialog button[type="submit"]');
await page.waitForTimeout(2500);
const stockCell = await page.locator('tr', { hasText: NAME }).locator('td').nth(3).textContent().catch(() => '');
check('the edit saved', stockCell?.trim() === '9', `stock cell reads "${stockCell?.trim()}"`);

console.log('--- delete it ---');
page.once('dialog', d => d.accept());
await page.locator('tr', { hasText: NAME }).locator('button:has-text("Delete")').click();
await page.waitForTimeout(2500);
check('the product is gone', (await page.locator(`text=${NAME}`).count()) === 0);
check(
  'the table is back to its original length',
  (await page.locator('.inventory-table-wrap tbody tr').count()) === rowsBefore
);

console.log('--- sign out ---');
await page.click('button:has-text("Sign out")');
await page.waitForSelector('form.login-form', { timeout: 10000 }).catch(() => {});
check('the login form is back', await page.locator('form.login-form').isVisible());

if (errors.length) console.log(`\npage errors:\n${errors.join('\n')}`);
console.log(problems.length ? `\nFAILED: ${problems.join('; ')}` : '\nall portal checks passed');
await browser.close();
process.exit(problems.length || errors.length ? 1 : 0);
