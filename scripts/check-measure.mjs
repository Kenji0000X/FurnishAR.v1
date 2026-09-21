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
  /*
     A phone does not send one reading per corner; it sends about sixty a
     second, and the person holds still for a moment before tapping. Firing
     a single event and tapping immediately is a test artefact that no
     handset can produce, and it hid behind the unsmoothed build: once the
     One Euro filter went in, one sample moved the heading barely at all and
     corners landed at 81, 52, 28 and 160 cm.

     So the fake phone streams, the way a real one does. The filter settles,
     the steadiness gate opens, and the geometry gets the angle it was aimed
     at rather than one frame of a turn.
  */
  window.__hold = (beta, alpha, samples = 40) => {
    for (let i = 0; i < samples; i += 1) window.__aim(beta, alpha);
  };
  /*
     Turning, not teleporting.

     A phone sweeps through every heading on the way to the next corner. The
     first version of this jumped straight from one bearing to the next,
     which is a step no sensor produces and which the glitch rejector
     correctly threw away — every corner then landed on the same spot and
     every wall measured 0 cm. Sweeping in small increments is both what a
     handset does and what the rejector is built to let through.
  */
  window.__turnTo = (beta, from, to, steps = 30) => {
    const delta = ((((to - from) % 360) + 540) % 360) - 180;
    for (let i = 1; i <= steps; i += 1) window.__aim(beta, from + (delta * i) / steps);
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
await page.evaluate(t => window.__hold(t, 53.130102), TILT);
await page.waitForTimeout(250);

/* The camera fills the view, the way the app this copies does it. */
const camBox = await page.locator('.ms-view').boundingBox();
const rootBox = await page.locator('.ms-root').boundingBox();
check('the camera fills the screen rather than sitting in a card',
  camBox.height > rootBox.height * 0.6, `${Math.round(camBox.height)} of ${Math.round(rootBox.height)}px`);
check('the reticle is drawn on the picture',
  await page.locator('.ms-view-svg circle').count() >= 2);
check('the prompt tells you what to do next, not what is wrong',
  await page.locator('.ms-tip').textContent().then(t => /Aim where the wall meets the floor/.test(t)));
check('and it says the markers are anchored to where you stand',
  await page.locator('.ms-anchor-warn').textContent()
    .then(t => /turn, don.t walk/i.test(t)));

// An impossible aim must refuse rather than invent.
await page.evaluate(() => window.__hold(86, 53.130102, 200));
await page.waitForTimeout(250);
check('aiming near level refuses instead of printing a number',
  await page.locator('.ms-tip').textContent().then(t => /Aim further down/.test(t)));
check('and the place button is disabled while it cannot measure',
  await page.locator('.ms-add').isDisabled());

/* The steadiness gate. Smoothing trails a fast turn by about four degrees,
   which at 2.5 m is 17 cm of error if a corner is placed mid-turn. The
   button must refuse until the reading settles, so the lag shows up as
   "hold still" rather than as a wrong wall.

   Tested at a tilt that CAN measure. At an unusable tilt the prompt rightly
   shows "aim further down" instead, because that is the more useful thing to
   say — so asserting "Hold still" there was asserting the wrong scenario. */
await page.evaluate(t => window.__hold(t, 0, 200), TILT);
await page.waitForTimeout(200);
check('a settled reading unlocks the button', !(await page.locator('.ms-add').isDisabled()));
await page.evaluate(t => window.__turnTo(t, 0, 40, 4), TILT);   // mid-turn
await page.waitForTimeout(60);
check('placing is blocked while the reading is still moving',
  await page.locator('.ms-add').isDisabled());
check('and it says to hold still rather than failing silently',
  await page.locator('.ms-tip').textContent().then(t => /Hold still/.test(t)));
// Then settle again so the room walk below starts from a clean state.
await page.evaluate(t => window.__hold(t, 53.130102, 200), TILT);
await page.waitForTimeout(200);

console.log('--- aim mode: walking a 4 x 3 m room ---');
const bearings = [53.130102, 126.869898, 233.130102, 306.869898];
let facing = 53.130102;
for (const bearing of bearings) {
  /* Turn, then hold. Sweeping is how a phone gets from one bearing to the
     next; the hold afterwards is the pause a person makes before tapping,
     and it is what lets the filter settle and the steadiness gate open. */
  await page.evaluate(([t, f, b]) => window.__turnTo(t, f, b), [TILT, facing, bearing]);
  await page.evaluate(([t, b]) => window.__hold(t, b, 200), [TILT, bearing]);
  await page.waitForTimeout(250);
  await page.click('.ms-add');
  facing = bearing;
}

/* The measurement must appear ON the picture, as a white pill on the line
   between two white endpoint dots — which is the whole look being copied.
   Turn back to face the first two corners so both are in frame. */
await page.evaluate(([t, f]) => window.__turnTo(t, f, 90), [TILT, facing]);
await page.evaluate(([t, b]) => window.__hold(t, b, 200), [TILT, 90]);
await page.waitForTimeout(250);
const onView = await page.locator('.ms-view-svg .ms-view-label').allTextContents();
check('lengths are drawn on the camera view, not only in a panel',
  onView.length > 0, onView.join(' · ') || 'no labels on the view');
check('and they read in centimetres like the reference app',
  onView.some(t => /^\d+ cm$/.test(t)), onView.join(' · '));
check('the line has white endpoint dots',
  await page.locator('.ms-view-svg circle[fill="#fff"]').count() >= 2);

await page.click('.ms-chip:has-text("Close")');
await page.waitForTimeout(200);
await page.click('.ms-chip:has-text("Plan")');
await page.waitForTimeout(250);

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
