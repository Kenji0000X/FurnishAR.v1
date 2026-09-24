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
  window.__aim = (beta, alpha, gamma = 0) => {
    window.dispatchEvent(Object.assign(new Event('deviceorientation'), {
      alpha, beta, gamma, absolute: true
    }));
  };
  /* The screen's rotation, as screen.orientation.angle reports it, so a
     landscape phone can be faked. */
  window.__screenAngle = 0;
  try {
    Object.defineProperty(screen.orientation, 'angle', { configurable: true, get: () => window.__screenAngle });
  } catch { /* older engines: portrait only */ }
  // A steady background stream, for the moments the phone is just held.
  setInterval(() => { if (window.__streaming) window.__aim(...window.__streaming); }, 20);
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
  window.__hold = (beta, alpha, samples = 40, gamma = 0) => {
    for (let i = 0; i < samples; i += 1) window.__aim(beta, alpha, gamma);
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
  /* The same, at a real sensor's pace: one reading every 16 ms. Synchronous
     bursts give the One Euro filter microsecond time steps, which no phone
     produces, and it then lags a turn by degrees that a real hand never sees. */
  window.__turnTimed = async (beta, from, to, steps = 30, settle = 80) => {
    const delta = ((((to - from) % 360) + 540) % 360) - 180;
    for (let i = 1; i <= steps + settle; i += 1) {
      window.__aim(beta, from + (delta * Math.min(i, steps)) / steps);
      await new Promise(r => setTimeout(r, 16));
    }
  };
  window.__turnTo = (beta, from, to, steps = 30) => {
    const delta = ((((to - from) % 360) + 540) % 360) - 180;
    for (let i = 1; i <= steps; i += 1) window.__aim(beta, from + (delta * i) / steps);
  };
});

console.log('--- getting to the measuring surface ---');
await page.goto(`${BASE}/plan`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.no-ar-cta button', { timeout: 15000 });
check('the planner offers a no-AR way in', await page.locator('.no-ar-cta button').isVisible());
await page.evaluate(() => { window.__streaming = [45, 0, 0]; });
await page.click('.no-ar-cta button');
await page.waitForSelector('.ms-root', { timeout: 15000 });
check('the measuring surface opens', await page.locator('.ms-root').isVisible());

console.log('--- the chooser: methods this phone was seen to support ---');
check('it asks how to measure first', /How would you like to measure/.test(await page.locator('.ms-title').textContent()));
check('four methods are offered', await page.locator('.ms-method-card').count() === 4,
  (await page.locator('.ms-method-title').allTextContents()).join(', '));
await page.waitForTimeout(1400);   // the sensor probe
check('the aim method reports what the sensor did', /Motion sensor responding/.test(
  await page.locator('.ms-method-card:has-text("Aim with phone")').first().textContent()));
check('tape measure is named the most accurate', /Most accurate/.test(
  await page.locator('.ms-method-card:has-text("Tape measure")').textContent()));
await page.evaluate(() => { window.__streaming = null; });
await page.click('.ms-method-card:has-text("Aim with phone") >> nth=0');

console.log('--- the height step comes first ---');
/*
   Every distance is height x tan(theta), so the holding height scales the
   WHOLE room. Hold the phone at 1.10 m while the app assumes 1.40 and every
   wall comes back 27% short with nothing on screen looking wrong — which is
   why it is asked before anything is measured rather than hidden in a sheet.
*/
check('the height is asked before the camera opens',
  await page.locator('.ms-subhead').textContent().then(t => /How high are you holding/.test(t)));
check('with the common holds offered as one tap',
  await page.locator('.ms-height-choices .ms-chip').count() === 3,
  (await page.locator('.ms-height-choices .ms-chip').allTextContents()).join(' | '));
check('and it explains why it matters',
  await page.locator('.ms-hint').first().textContent().then(t => /scales the whole room/.test(t)));
check('the camera does not open until it is answered',
  await page.locator('.ms-view').count() === 0);
await page.click('.ms-actions button:has-text("Start measuring")');
await page.waitForSelector('.ms-view', { timeout: 10000 });
check('answering it opens the camera', await page.locator('.ms-view').isVisible());

console.log('--- calibration ---');
check('it asks to calibrate before measuring', /Hold the phone upright and level/.test(
  await page.locator('.ms-calibrate').textContent().catch(() => '')));
// A phone that reads 88.5 at true upright: calibration takes the 1.5 off.
await page.evaluate(() => window.__hold(88.5, 0, 5));
await page.click('.ms-calibrate button:has-text("Calibrate")');
await page.evaluate(() => window.__hold(88.5, 0, 40));
await page.waitForTimeout(900);
check('calibration completes', await page.locator('.ms-calibrate').count() === 0);

console.log('--- aim mode: the live readout ---');
// Calibrated by +1.5 degrees, so the fake phone aims 1.5 low to hit 60.75.
const TILT = Math.atan(2.5 / 1.4) * 180 / Math.PI - 1.5;
await page.evaluate(t => window.__hold(t, 53.130102, 200), TILT);
await page.waitForTimeout(250);
check('the calibrated angle reaches the trigonometry: 2.50 m to the crosshair',
  /2\.5/.test(await page.locator('.ms-distance').textContent().catch(() => '')),
  await page.locator('.ms-distance').textContent().catch(() => ''));

/* The camera fills the view, the way the app this copies does it. */
const camBox = await page.locator('.ms-view').boundingBox();
const rootBox = await page.locator('.ms-root').boundingBox();
check('the camera fills the screen rather than sitting in a card',
  camBox.height > rootBox.height * 0.6, `${Math.round(camBox.height)} of ${Math.round(rootBox.height)}px`);
check('the reticle is drawn on the picture',
  await page.locator('.ms-view-svg circle').count() >= 2);
check('the prompt tells you what to do next, not what is wrong',
  await page.locator('.ms-tip').textContent().then(t => /Aim where the wall meets the floor/.test(t)),
  await page.locator('.ms-tip').textContent());
check('and it says the markers are anchored to where you stand',
  await page.locator('.ms-anchor-warn').textContent()
    .then(t => /turn, don.t walk/i.test(t)));

// Rolled 25 degrees: the simplified distance no longer holds, so capture stops.
await page.evaluate(t => window.__hold(t, 53.130102, 60, 25), TILT);
await page.waitForTimeout(200);
check('a heavily rolled phone is told to straighten', /Straighten the phone/.test(await page.locator('.ms-tip').textContent()));
check('and cannot place a corner', await page.locator('.ms-add').isDisabled());
await page.evaluate(t => window.__hold(t, 53.130102, 200), TILT);

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

console.log('--- tape measure: units, and the field regression ---');
await page.evaluate(() => { window.__streaming = [45, 0, 0]; });
await page.click('.no-ar-cta button');
await page.waitForSelector('.ms-root');
await page.waitForTimeout(1400);   // the sensor probe sees a live sensor
await page.evaluate(() => { window.__streaming = null; });
await page.click('.ms-method-card:has-text("Tape measure")');
const typedField = label => `.ms-typed label:has-text("${label}") input`;
// The field test: 90 / 100 / 600 typed into metres, meaning centimetres.
await page.fill(typedField('Length'), '90');
await page.fill(typedField('Width'), '100');
await page.fill(typedField('Height'), '600');
await page.waitForTimeout(150);
const notes = (await page.locator('.ms-typed-note').allTextContents()).join(' | ');
check('90 m is refused with the unit named', /90 m is far too large for a room\. Check the selected unit\./.test(notes), notes.slice(0, 160));
check('no giant room can be used', await page.locator('.ms-foot button:has-text("Use this room")').isDisabled());
check('it offers to read the same digits as centimetres',
  await page.locator('button:has-text("Read these as centimetres")').count() === 1);
await page.click('button:has-text("Read these as centimetres")');
await page.waitForTimeout(150);
const cmNotes = (await page.locator('.ms-typed-note').allTextContents()).join(' | ');
check('read as centimetres they are checked again, not accepted blindly', /unusually/.test(cmNotes), cmNotes);
check('unusual sizes must be confirmed', await page.locator('.ms-confirm input').count() === 1);
await page.check('.ms-confirm input');
check('once confirmed, the room can be used', !(await page.locator('.ms-foot button:has-text("Use this room")').isDisabled()));

// Changing the unit converts, never reinterprets.
await page.fill(typedField('Length'), '420');
await page.fill(typedField('Width'), '310');
await page.fill(typedField('Height'), '270');
await page.click('.ms-unit:has-text("m") >> nth=0');
await page.waitForTimeout(150);
check('420 cm becomes 4.2 m when switched to metres', await page.inputValue(typedField('Length')) === '4.2',
  await page.inputValue(typedField('Length')));
await page.click('.ms-unit:has-text("ft")');
await page.waitForTimeout(150);
const feet = Number(await page.inputValue(typedField('Length')));
check('and 13.78 ft in feet', Math.abs(feet - 13.78) < 0.01, String(feet));
await page.click('.ms-unit:has-text("m") >> nth=0');
await page.fill(typedField('Length'), '5');
await page.fill(typedField('Width'), '4');
await page.fill(typedField('Height'), '2.6');
await page.waitForTimeout(200);
const typedPlan = await page.locator('.ms-plan').textContent();
check('typed figures produce the same kind of plan', /500 cm/.test(typedPlan) && /400 cm/.test(typedPlan),
  typedPlan.replace(/\s+/g, ' ').slice(0, 120));
check('with volume, since a height was given', /V = 52\.00 m³/.test(typedPlan), typedPlan.match(/V = [^ ]* m³/)?.[0]);
check('the summary names the method', /Tape measure/.test(await page.locator('.ms-summary').textContent()));

console.log('--- landscape: the angle comes from the whole orientation, not beta ---');
await page.click('.ms-back');
await page.click('.ms-method-card:has-text("single distances")');
await page.waitForTimeout(300);
if (await page.locator('.ms-actions button:has-text("Start measuring")').count()) {
  await page.click('.ms-actions button:has-text("Start measuring")');
}
await page.waitForSelector('.ms-view', { timeout: 10000 });
if (await page.locator('.ms-calibrate button:has-text("Skip")').count()) {
  await page.click('.ms-calibrate button:has-text("Skip")');
}
// Phone on its side, screen rotated 90, aimed at the corner 2.5 m away.
// The browser reports beta ~ 0 and gamma ~ 60.75; the old code read beta
// as the angle and saw the floor at the person's feet.
await page.evaluate(() => { window.__screenAngle = 90; });
await page.evaluate(() => { for (let i = 0; i < 200; i += 1) window.__aim(0, 270, 60.751173663453024); });
await page.waitForTimeout(250);
const landscape = await page.locator('.ms-distance').textContent().catch(() => '');
check('in landscape the same aim still reads 2.50 m', /2\.5/.test(landscape), landscape);
await page.evaluate(() => { window.__screenAngle = 0; });

console.log('--- point to point: measuring a thing, not a room ---');
/*
   The interaction the reference apps are built on, and the one FurnishAR
   could not do at all: tap one end, tap the other, get the length. It is
   what measures a sofa, a doorway or the span of a single wall.

   Geometry: two floor points 2.5 m from the stander, 90 degrees apart, are
   2.5*sqrt(2) = 3.54 m from each other.
*/
// Portrait again, aiming 60.75 degrees (uncalibrated: calibration was skipped).
const TILT_RAW = Math.atan(2.5 / 1.4) * 180 / Math.PI;
await page.evaluate(t => window.__hold(t, 0, 200), TILT_RAW);
await page.waitForTimeout(250);
check('it asks for the first end', await page.locator('.ms-tip').textContent()
  .then(t => /Aim at one end/.test(t)));
await page.click('.ms-add');
await page.waitForTimeout(150);
check('and then asks for the other end', await page.locator('.ms-tip').textContent()
  .then(t => /other end/.test(t)));

await page.evaluate(t => window.__turnTimed(t, 0, 90), TILT_RAW);
await page.waitForTimeout(250);
await page.click('.ms-add');
await page.waitForTimeout(250);

const tape = await page.locator('.ms-tape-row b').allTextContents();
check('the segment is recorded with its length', tape.length === 1, tape.join(', '));
/* 2.5 m apart at 90 degrees: 3.54 m. Shown to whatever precision the doubt
   supports, so both an exact and an approximate rendering are acceptable —
   what must not happen is a number that is simply wrong. */
check('and the length is right', /3\.5/.test(tape[0] || ''), tape[0]);
check('the measurement carries a confidence grade',
  await page.locator('.ms-tape-row small').textContent().then(t => /High|Medium|Low/.test(t)),
  await page.locator('.ms-tape-row small').textContent().catch(() => ''));
check('and says which method produced it',
  await page.locator('.ms-tape-row small').textContent().then(t => /tilt \+ gyroscope/.test(t)));
check('the line is drawn on the picture with its label',
  await page.locator('.ms-view-svg .ms-view-label').count() >= 1);

await page.click('.ms-chip:has-text("Undo")');
await page.waitForTimeout(200);
check('undo removes the measurement', await page.locator('.ms-tape-row').count() === 0);

console.log('--- photo reference: four corners, then the line ---');
await page.click('.ms-back');
await page.click('.ms-method-card:has-text("Photo reference")');
await page.waitForTimeout(800);
check('it asks for the reference first', /A4 paper/.test(await page.locator('.ms-field select').textContent()));
await page.waitForFunction(() => document.querySelector('.ms-video')?.videoWidth > 0, null, { timeout: 10000 }).catch(() => {});
await page.click('button:has-text("Take the photo")');
await page.waitForSelector('.ms-photo', { timeout: 10000 });
const box = await page.locator('.ms-photo').boundingBox();
const at = (fx, fy) => page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
check('it asks for the top-left corner first', /top-left corner/.test(await page.locator('.ms-stage .ms-hint').first().textContent()));
// An A4 sheet seen square on: 30% of the width across, 21/29.7 of that down.
const w = 0.3, h = 0.3 * (box.width / box.height) * (0.210 / 0.297);
await at(0.3, 0.3); await at(0.3 + w, 0.3); await at(0.3 + w, 0.3 + h); await at(0.3, 0.3 + h);
await page.waitForTimeout(150);
check('four corners correct the perspective', /Perspective corrected/.test(await page.locator('.ms-stage .ms-hint').first().textContent()),
  await page.locator('.ms-stage .ms-hint').first().textContent());
await at(0.1, 0.6); await at(0.1 + 0.8, 0.6);   // 0.8 / 0.3 of 29.7 cm = 79 cm
await page.waitForTimeout(150);
const result = await page.locator('.ms-result').textContent().catch(() => '');
check('the line is measured in the rectified plane', /79 cm/.test(result), result.slice(0, 60));
check('with its uncertainty and the one-plane rule', /±/.test(result) && /valid only on the wall the reference is on/.test(result));
await page.click('.ms-photo-tools button:has-text("Undo point")');
check('undo removes the last point', await page.locator('.ms-result').count() === 0);
await page.click('.ms-photo-tools button[aria-label="Zoom in"]');
check('zoom is available for precise corners', !(await page.locator('.ms-photo-tools button:has-text("Fit")').isDisabled()));

check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await browser.close();
console.log(problems.length ? `\nFAILED: ${problems.join('; ')}` : '\nthe no-AR scanner measures a room end to end');
process.exit(problems.length ? 1 : 0);
