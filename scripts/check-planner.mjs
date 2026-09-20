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
    // The picker used to be a static <h3>. It is a radiogroup now, so the
    // name to read is the selected choice's — the old selector matched
    // nothing and quietly printed an empty string.
    productName: document.querySelector('#planner-product .planner-choice[aria-checked="true"] b')?.textContent || '',
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

/* ---------------------------------------------- the product picker ------ */
/*
   Card 01 is titled "Pick a product" and, until recently, presented no way to
   pick one: it rendered whichever piece you arrived with as static markup.
   selectProduct() existed and worked; nothing in the UI ever called it. So
   somebody opening the planner from the nav got whichever product happened to
   be first, with no sign that it was a choice.

   The switching half of this only has something to exercise once two pieces
   in the catalogue have models. It is written to say so rather than to pass
   quietly, and it strengthens on its own the day a second shop uploads one.
*/
await page.goto(`${BASE}/plan`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

const picker = await page.evaluate(() => {
  const choices = [...document.querySelectorAll('.planner-choice')];
  return {
    count: choices.length,
    checked: choices.filter(c => c.getAttribute('aria-checked') === 'true').length,
    names: choices.map(c => c.querySelector('b')?.textContent?.trim()),
    group: Boolean(document.querySelector('.planner-choices[role="radiogroup"]')),
    empty: Boolean(document.querySelector('.planner-empty'))
  };
});

/*
   Until now this file only printed; it had no exit code at all, so `npm run
   check:planner` was green whatever it found. A line reading FAIL that still
   exits 0 is worse than no check — it is a check nobody will ever see fail in
   CI. Assertions are recorded and the process exits non-zero if any of them,
   or any page error, landed.
*/
const problems = [];
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(label);
};

console.log('--- the product picker ---');
if (picker.empty) {
  console.log('  ok   no piece has a model yet, and the card says so rather than');
  console.log('       offering a choice that cannot be taken');
} else {
  check('the choices are a radiogroup', picker.group);
  check('exactly one is selected', picker.checked === 1, `${picker.checked} of ${picker.count}`);
  console.log(`       offering: ${picker.names.join(', ')}`);

  if (picker.count < 2) {
    console.log('  --   only one piece in the catalogue has a model, so switching');
    console.log('       between products is NOT exercised here. This check covers');
    console.log('       it automatically once a second model is uploaded.');
  } else {
    const before = await page.textContent('#check-width');
    await page.click('.planner-choice:not(.is-current)');
    await page.waitForTimeout(400);
    const moved = await page.evaluate(() => {
      const current = document.querySelector('.planner-choice.is-current');
      return {
        checked: document.querySelectorAll('.planner-choice[aria-checked="true"]').length,
        name: current?.querySelector('b')?.textContent?.trim(),
        width: document.getElementById('check-width')?.textContent
      };
    });
    check('still exactly one selected after switching', moved.checked === 1);
    // The dimensions feeding the verdict must follow the selection, or the
    // fit check silently answers for the previous piece.
    check('the fit check follows the new piece', moved.width !== before, `${before} -> ${moved.width}`);
  }
}

console.log(errors.length ? `\n*** PAGE ERRORS ***\n${errors.join('\n')}` : '\nno page errors');
await browser.close();

if (errors.length) problems.push(`${errors.length} page error(s)`);
console.log(problems.length ? `\nFAILED: ${problems.join('; ')}` : '\nall planner checks passed');
process.exit(problems.length ? 1 : 0);
