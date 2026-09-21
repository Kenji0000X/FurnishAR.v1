/**
 * Drives the no-AR measuring surface in a real browser, with a fake phone.
 *
 * The maths has unit tests (tests/clinometer.test.js, tests/photo-scale.test.js).
 * What those cannot show is whether the thing on screen is wired to it: that
 * the tilt sensor reaches the trigonometry, that a tap places the corner from
 * the angle at the instant of the tap, that the floor plan draws what was
 * measured, and that "Use this room" actually lands in the planner rather
 * than printing a number and forgetting it.
 *
 * The fake phone stands in the middle of a 4 x 3 m room holding the phone at
 * 1.40 m, and turns to each corner in turn. From the centre every corner is
 * half the diagonal away — hypot(2, 1.5) = 2.5 m — so every shot is taken at
 * the same tilt, atan(2.5 / 1.4) = 60.75 degrees, with only the compass
 * bearing changing. If the wiring is right, the surface must report 4.00 x
 * 3.00 m and 12.00 m2.
 *
 *   node scripts/check-measure.mjs [baseUrl]
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://localhost:4173';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  // getUserMedia must resolve, or the surface never leaves its camera state.
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-capture']
});

const problems = [];
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(label);
};

const context = await browser.newContext({
  viewport: { width: 390, height: 780 },
  permissions: ['camera']
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));

/* The phone. beta is the tilt from straight down, alpha the compass bearing;
   both are fed as real DeviceOrientationEvent-shaped objects so the component
   reads them exactly as it would on a handset. */
await page.addInitScript(() => {
  window.__aim = (beta, alpha) => {
    window.dispatchEvent(Object.assign(new Event('deviceorientation'), {
      alpha, beta, gamma: 0, absolute: true
    }));
  };
});

console.log('--- getting to the measuring surface ---');
await page.goto(`${BASE}/plan`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.no-ar-cta button', { timeout: 15000 });
check('the planner offers a no-AR way in', await page.locator('.no-ar-cta button').isVisible());
await page.click('.no-ar-cta button');
await page.waitForSelector('.ms-root', { timeout: 15000 });
check('the measuring surface opens', await page.locator('.ms-root').isVisible());
check('all three methods are offered', await page.locator('.ms-mode').count() === 3,
  (await page.locator('.ms-mode').allTextContents()).join(', '));

console.log('--- aim mode: the live readout ---');
const TILT = Math.atan(2.5 / 1.4) * 180 / Math.PI;   // 60.75 degrees
await page.evaluate(t => window.__aim(t, 53.130102), TILT);
await page.waitForTimeout(150);

const liveText = await page.locator('.ms-live').textContent();
/* 1.40 * tan(60.75) = 2.50 m. The readout must say so, live, before any tap. */
check('aiming shows the distance without tapping anything', /250 cm/.test(liveText), liveText.trim());
check('and carries the uncertainty rather than a bare number', /±\s*\d+ cm/.test(liveText), liveText.trim());
check('the trust grading says this one is good',
  await page.locator('.ms-live.is-good').count() === 1);

// The readout must TRACK, not latch: a different angle must give a different
// number without any interaction at all.
await page.evaluate(() => window.__aim(45, 53.130102));
await page.waitForTimeout(150);
const at45 = await page.locator('.ms-live b').first().textContent();
check('the reading is live, not latched', /140 cm/.test(at45), `at 45°: ${at45}`);

// And an impossible aim must refuse rather than invent.
await page.evaluate(() => window.__aim(86, 53.130102));
await page.waitForTimeout(150);
check('aiming near level refuses instead of printing a number',
  await page.locator('.ms-hint').first().textContent().then(t => /Aim further down/.test(t)));
check('and the corner button is disabled while it cannot measure',
  await page.locator('.ms-actions button:has-text("Tap corner")').isDisabled());

console.log('--- aim mode: walking a 4 x 3 m room ---');
const bearings = [53.130102, 126.869898, 233.130102, 306.869898];
for (const bearing of bearings) {
  await page.evaluate(([t, b]) => window.__aim(t, b), [TILT, bearing]);
  await page.waitForTimeout(120);
  await page.click('.ms-actions button:has-text("Tap corner")');
}
check('four corners were taken',
  /Tap corner \(4\)/.test(await page.locator('.ms-actions button:has-text("Tap corner")').textContent()));

await page.click('.ms-actions button:has-text("Close outline")');
await page.waitForTimeout(200);

const plan = await page.locator('.ms-plan').textContent();
check('the floor plan reports the long side as 4.00 m', /400 cm/.test(plan), plan.replace(/\s+/g, ' ').slice(0, 160));
check('and the short side as 3.00 m', /300 cm/.test(plan));
check('the area is derived and shown', /S = 12\.00 m²/.test(plan), plan.match(/S = [^P]*/)?.[0]);
check('the perimeter is shown', /P = 1400 cm/.test(plan));

console.log('--- the visual language from the reference app ---');
const golds = await page.locator('.ms-plan rect[fill="#f2c14e"]').count();
const violets = await page.locator('.ms-plan rect[fill="#7b6bd9"]').count();
check('lengths sit in gold pills on the edges, one per edge', golds === 4, `${golds} gold pills`);
check('derived values sit in violet pills in the middle', violets >= 4, `${violets} violet pills`);
check('corners are drawn as vertex dots',
  await page.locator('.ms-plan circle').count() >= 5,
  `${await page.locator('.ms-plan circle').count()} dots`);

console.log('--- handing the room to the planner ---');
const summary = await page.locator('.ms-summary').textContent();
check('the footer summarises before committing', /4\.00 m × 3\.00 m/.test(summary), summary.trim());
await page.click('.ms-foot button:has-text("Use this room")');
await page.waitForTimeout(500);
check('the measuring surface closes', await page.locator('.ms-root').count() === 0);

/* The real integration: the engine must have adopted it, which means its own
   room panel — not a copy written by the measuring surface — now shows it. */
const adoptedNote = await page.locator('.ar-status:has-text("measured without AR")').textContent().catch(() => '');
check('the planner says it is using the measured room', /4\.00 × 3\.00 m/.test(adoptedNote), adoptedNote.trim());
const resultLength = await page.locator('#room-result-length').textContent();
const resultArea = await page.locator('#room-result-area').textContent();
check('the engine\'s own room panel took the length', /4\.00/.test(resultLength), resultLength);
check('and the area', /12/.test(resultArea), resultArea);

console.log('--- type mode: the most accurate of the three ---');
await page.click('.no-ar-cta button');
await page.waitForSelector('.ms-root');
await page.click('.ms-mode:has-text("Type")');
await page.fill('.ms-typed label:has-text("Length") input', '5');
await page.fill('.ms-typed label:has-text("Width") input', '4');
await page.fill('.ms-typed label:has-text("Height") input', '2.6');
await page.waitForTimeout(200);
const typedPlan = await page.locator('.ms-plan').textContent();
check('typed figures produce the same kind of plan', /500 cm/.test(typedPlan) && /400 cm/.test(typedPlan),
  typedPlan.replace(/\s+/g, ' ').slice(0, 120));
check('with volume, since a height was given', /V = 52\.00 m³/.test(typedPlan), typedPlan.match(/V = [^ ]* m³/)?.[0]);
check('and it is not framed as a consolation prize',
  await page.locator('.ms-hint').first().textContent().then(t => /most reliable/.test(t)));

console.log('--- photo mode ---');
await page.click('.ms-mode:has-text("Photo")');
await page.waitForTimeout(300);
check('photo mode asks for a known-size object first',
  await page.locator('.ms-hint').first().textContent().then(t => /A4|bank card|known/i.test(t)));

check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await browser.close();
console.log(problems.length ? `\nFAILED: ${problems.join('; ')}` : '\nthe no-AR scanner measures a room end to end');
process.exit(problems.length ? 1 : 0);
