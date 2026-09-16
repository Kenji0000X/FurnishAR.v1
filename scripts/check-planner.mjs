/**
 * Does the moved AR engine actually drive the React-rendered planner DOM?
 * The build passing proves nothing here — the engine finds its elements by id
 * at runtime, so this loads the real page and checks what it wrote.
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:4300';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();

const errors = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

await page.goto(`${BASE}/plan`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#point-b', { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(2000);

const result = await page.evaluate(() => {
  const text = id => document.getElementById(id)?.textContent?.trim() || '';
  return {
    plannerProduct: document.getElementById('planner-product')?.innerHTML.length || 0,
    productName: document.querySelector('#planner-product h3')?.textContent || '',
    checkWidth: text('check-width'),
    checkDepth: text('check-depth'),
    checkClearance: text('check-clearance'),
    verdict: text('fit-verdict').slice(0, 60),
    arStatus: text('ar-status'),
    measuredDistance: text('measured-distance'),
    planPieceLabel: text('fit-plan-piece-label'),
    modeActive: document.querySelector('.mode-option.is-active')?.textContent?.trim()
  };
});

console.log('--- planner after the engine mounted ---');
for (const [k, v] of Object.entries(result)) console.log(`  ${k}: ${JSON.stringify(v)}`);

// Interaction: changing a measurement must re-run the fit verdict.
await page.fill('#point-b', '60');
await page.dispatchEvent('#point-b', 'input');
await page.waitForTimeout(400);
const after = await page.evaluate(() => ({
  clearance: document.getElementById('check-clearance')?.textContent?.trim(),
  verdict: document.getElementById('fit-verdict')?.textContent?.trim().slice(0, 60)
}));
console.log('--- after setting clearance to 60 cm (narrower than the 70 cm chair) ---');
console.log(' ', JSON.stringify(after));

// Mode switch must swap the field sets.
await page.click('.mode-option[data-measure-mode="area"]');
await page.waitForTimeout(300);
const mode = await page.evaluate(() => ({
  clearanceHidden: document.getElementById('clearance-fields')?.hidden,
  areaHidden: document.getElementById('area-fields')?.hidden,
  label: document.getElementById('check-clearance-label')?.textContent
}));
console.log('--- after switching to floor-area mode ---');
console.log(' ', JSON.stringify(mode));

console.log(errors.length ? `\n*** PAGE ERRORS ***\n${errors.join('\n')}` : '\nno page errors');
await browser.close();
