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
// Not #point-b any more: whole-room is the default mode now, so the clearance
// fields start hidden and waiting for one of them to be *visible* waits out
// the timeout on a page that is perfectly fine.
await page.waitForSelector('.mode-option.is-active', { timeout: 20000 }).catch(() => {});
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

// The scan, not the shopping decision, is what the planner opens on.
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

console.log('--- what the planner opens on ---');
console.log(`  ${result.modeActive === 'Whole room' ? 'ok  ' : 'FAIL'} whole-room is the default mode — ${JSON.stringify(result.modeActive)}`);
const opensOnScan = await page.evaluate(() => ({
  roomFieldsShown: document.getElementById('room-fields')?.hidden === false,
  clearanceHidden: document.getElementById('clearance-fields')?.hidden === true,
  settings: !!document.querySelector('.scan-settings'),
  units: [...document.querySelectorAll('.unit-option')].map(b => b.dataset.unit),
  clearancePref: !!document.getElementById('clearance-pref')
}));
console.log(' ', JSON.stringify(opensOnScan));

/*
   Interaction: changing a measurement must re-run the fit verdict.

   The Clearance MODE is gone — it measured the gap across an opening, a
   different question from "how big is this room", and being first it made
   the scanner open on the narrowest thing it could do. The two-point FIELDS
   remain and are always available, because typing a figure you measured with
   a tape is still the most accurate input there is. So this no longer
   switches mode; it just uses the fields.
*/
check('the clearance tab is gone',
  await page.locator('.mode-option[data-measure-mode="clearance"]').count() === 0);
check('and only the two room modes are offered',
  await page.locator('.mode-option').count() === 2,
  (await page.locator('.mode-option').allTextContents()).join(', '));
check('the two-point fields are still reachable without it',
  await page.locator('#point-b').isVisible());

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

console.log('--- the product picker ---');
if (picker.empty) {
  console.log('  ok   no piece has a model yet, and the card says so rather than');
  console.log('       offering a choice that cannot be taken');
} else {
  check('the choices are a radiogroup', picker.group);
  /* Nothing is selected on arrival, on purpose: measuring a room must not
     start with a shopping decision. The planner used to arm itself with the
     first piece that had a model, which is how a product nobody chose ended
     up pinned over the camera during a measurement. */
  check('nothing is pre-selected for you', picker.checked === 0, `${picker.checked} of ${picker.count} checked`);
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


/* ------------------------------------------------ the whole-room scan --- */
/*
   There is no XR device in CI, so this drives the scan through the seam the
   engine exposes: synthetic surfaces of a KNOWN room go in at exactly the
   point WebXR's detected planes would, and everything downstream — the
   derivation, the panel, the readiness gate, the kept result and the verdict
   — is the real code.

   What this does NOT prove: plane detection, depth sensing, tracking quality
   or real-world accuracy. Those need a physical Android device, and this
   check says so rather than implying a green run covers them.
*/
await page.goto(`${BASE}/plan`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => Boolean(window.__furnisharScan), null, { timeout: 15000 });

console.log('--- the whole-room scan ---');

// A room known in advance: 4.81 m x 3.42 m x 2.70 m, deliberately rotated 25
// degrees off the tracking axes, which is how every real scan arrives.
const ROOM = await page.evaluate(() => {
  const rotate = (x, z, a) => ({ x: x * Math.cos(a) - z * Math.sin(a), z: x * Math.sin(a) + z * Math.cos(a) });
  const angle = (25 * Math.PI) / 180;
  const rect = (L, W, y) => [[-L / 2, -W / 2], [L / 2, -W / 2], [L / 2, W / 2], [-L / 2, W / 2]]
    .map(([u, v]) => { const r = rotate(u, v, angle); return { x: r.x, y, z: r.z }; });

  const surfaces = [
    { orientation: 'horizontal', polygon: rect(4.81, 3.42, 0) },
    { orientation: 'horizontal', polygon: rect(4.81, 3.42, 2.70) }
  ];
  // Two walls, so the readiness gate is satisfied honestly.
  for (const z of [-1.71, 1.71]) {
    surfaces.push({ orientation: 'vertical', polygon: [
      { x: -2.4, y: 0, z }, { x: 2.4, y: 0, z },
      { x: 2.4, y: 2.70, z }, { x: -2.4, y: 2.70, z }
    ] });
  }

  window.__furnisharScan.openPanel();
  const room = window.__furnisharScan.feed(surfaces);
  return { length: room.length, width: room.width, height: room.height, area: room.floorArea, walls: room.walls };
});

const near = (value, target, tolerance) => Math.abs(value - target) <= tolerance;
check('the floor measures its true length despite the 25deg rotation',
  near(ROOM.length, 4.81, 0.01), `${ROOM.length?.toFixed(3)} m, expected 4.81`);
check('and its true width', near(ROOM.width, 3.42, 0.01), `${ROOM.width?.toFixed(3)} m, expected 3.42`);
check('the ceiling gives the height', near(ROOM.height, 2.70, 0.01), `${ROOM.height?.toFixed(3)} m`);
check('the floor area follows', near(ROOM.area, 16.45, 0.05), `${ROOM.area?.toFixed(2)} m2`);

// The gate: a measured room is not enough on its own, the sweep must be done.
const beforeSweep = await page.evaluate(() => window.__furnisharScan.state.readiness);
check('a found room with no sweep is not ready yet',
  beforeSweep.ready === false && beforeSweep.blocking.includes('sweep'),
  `blocking: ${beforeSweep.blocking.join(', ')}`);

const afterSweep = await page.evaluate(() => {
  window.__furnisharScan.sweepTo(180);
  return window.__furnisharScan.state.readiness;
});
check('after a full sweep it is ready', afterSweep.ready === true, `blocking: ${afterSweep.blocking.join(', ')}`);

// What a person actually sees on the panel.
const panel = await page.evaluate(() => ({
  length: document.getElementById('room-length')?.textContent,
  width: document.getElementById('room-width')?.textContent,
  height: document.getElementById('room-height')?.textContent,
  area: document.getElementById('room-area')?.textContent,
  walls: document.getElementById('found-walls')?.textContent,
  sweep: document.getElementById('found-sweep')?.textContent,
  ticks: document.querySelectorAll('#scan-arc i[data-swept="yes"]').length,
  useRoomDisabled: document.getElementById('use-room')?.disabled
}));
check('the panel shows the measured length', panel.length === '4.81 m', panel.length);
check('the panel shows the measured width', panel.width === '3.42 m', panel.width);
check('the panel shows the measured height', panel.height === '2.70 m', panel.height);
check('the sweep arc filled in', panel.ticks >= 30, `${panel.ticks} ticks lit`);
check('"Use this room" is only offered once the scan is ready', panel.useRoomDisabled === false);

// Accepting the room carries it to the planner card and the verdict.
const accepted = await page.evaluate(() => {
  document.querySelector('.mode-option[data-measure-mode="room"]')?.click();
  window.__furnisharScan.accept();
  /* Snapshot the measure-only state first: room scanned, nothing chosen.
     That is the whole point of the workflow and nothing was checking it. */
  window.__furnisharMeasureOnly = {
    verdict: document.getElementById('fit-verdict')?.textContent?.replace(/\s+/g, ' ').trim(),
    planLabel: document.getElementById('fit-plan-space-label')?.textContent
  };
  /* Choose the piece HERE, after the room is measured — which is the order
     the product now works in. Nothing is selected on arrival, so asserting a
     fit verdict without picking something was passing against the "no piece
     chosen" message rather than against any fit calculation. */
  document.querySelector('.planner-choice')?.click();
  return {
    cardLength: document.getElementById('room-result-length')?.textContent,
    cardHeight: document.getElementById('room-result-height')?.textContent,
    verdictTitle: document.getElementById('verdict-title')?.textContent,
    verdict: document.getElementById('fit-verdict')?.textContent?.replace(/\s+/g, ' ').trim(),
    failed: document.getElementById('fit-verdict')?.className.includes('fail'),
    planLabel: document.getElementById('fit-plan-space-label')?.textContent,
    // Captured BEFORE the piece is chosen, above: this is what somebody who
    // only wanted the measurements actually sees.
    beforePicking: window.__furnisharMeasureOnly
  };
});
check('a room measures fully with nothing selected',
  /Room measured/.test(accepted.beforePicking?.verdict || ''),
  (accepted.beforePicking?.verdict || '(nothing)').slice(0, 70));
check('and its plan view is drawn without a piece in it',
  /4\.81 m . 3\.42 m/.test(accepted.beforePicking?.planLabel || ''),
  accepted.beforePicking?.planLabel);
check('the measurement survives the scan and lands on the card',
  accepted.cardLength === '4.81 m' && accepted.cardHeight === '2.70 m',
  `${accepted.cardLength} / ${accepted.cardHeight}`);
check('the verdict is now about the room, not a span',
  accepted.verdictTitle === 'Room verdict', accepted.verdictTitle);
check('an armchair fits a 4.81 x 3.42 m room', accepted.failed === false,
  accepted.verdict?.slice(0, 80));
check('the plan view is drawn at the room’s real proportions',
  /4\.81 m . 3\.42 m/.test(accepted.planLabel || ''), accepted.planLabel);


/* ------------------------------ the room scan WITHOUT plane detection --- */
/*
   The failure this exists to catch.

   The whole-room scan was built on frame.detectedPlanes, which Chrome for
   Android does not ship outside chrome://flags/#webxr-incubations. On an
   ordinary phone `supported` came back false, state.room was never assigned,
   and the room could not be measured at all — the product's headline feature,
   dead on the device it was built for, while every check in this file passed
   because they all fed it synthetic PLANES.

   So this one never touches the plane path. It taps corners, the way a person
   standing in the room does, and asserts a real measurement comes out.
   A 4.00 x 3.00 m room, tapped at its four corners, with a ceiling at 2.50 m.
*/
console.log('--- the room scan with NO plane detection (tap the corners) ---');
const tapped = await page.evaluate(async () => {
  window.__furnisharScan.reset();
  window.__furnisharScan.openPanel();
  // Deliberately NOT calling feed(): detectedPlanes is unavailable here, the
  // same as on the phone this failed on.
  const corners = [
    { x: 0, y: 0, z: 0 },
    { x: 4, y: 0, z: 0 },
    { x: 4, y: 0, z: 3 },
    { x: 0, y: 0, z: 3 }
  ];
  for (const corner of corners) window.__furnisharScan.tapCorner(corner);
  window.__furnisharScan.closeFloor();
  const beforeHeight = window.__furnisharScan.state.room;
  window.__furnisharScan.tapCorner({ x: 2, y: 2.5, z: 1.5 });   // the ceiling
  const room = window.__furnisharScan.state.room;
  const firstReady = window.__furnisharScan.state.readiness?.ready;
  const useRoomLabel = document.getElementById('use-room')?.textContent;

  /* A second, independent scan confirms the first. One wildly off (40 cm
     longer) is refused; one that agrees confirms. And a "corner" on a table
     top 45 cm above the floor is refused, not flattened onto it. */
  window.__furnisharScan.confirmScan();
  window.__furnisharScan.tapCorner({ x: 0, y: 0.45, z: 0 });
  const tableRefused = window.__furnisharScan.state.taps.corners.length === 0;
  const off = [{ x: 0, y: 0, z: 0 }, { x: 4.4, y: 0, z: 0 }, { x: 4.4, y: 0, z: 3 }, { x: 0, y: 0, z: 3 }];
  for (const corner of off) window.__furnisharScan.tapCorner(corner);
  window.__furnisharScan.closeFloor();
  const afterDisagreement = window.__furnisharScan.state.readiness?.ready;

  window.__furnisharScan.confirmScan();
  const again = [{ x: 0.01, y: 0.005, z: 0 }, { x: 4.02, y: 0, z: 0.01 }, { x: 4.01, y: -0.004, z: 3.01 }, { x: 0, y: 0, z: 2.99 }];
  for (const corner of again) window.__furnisharScan.tapCorner(corner);
  window.__furnisharScan.closeFloor();
  const confirmedRoom = window.__furnisharScan.state.room;
  return {
    planesSupported: window.__furnisharScan.state.netSupport.planes,
    heightBefore: beforeHeight?.height,
    length: room?.length, width: room?.width, height: room?.height,
    area: room?.floorArea, perimeter: room?.perimeter, volume: room?.volume,
    firstReady, useRoomLabel, tableRefused, afterDisagreement,
    confirmedLength: confirmedRoom?.length,
    ready: window.__furnisharScan.state.readiness?.ready,
    blocking: window.__furnisharScan.state.readiness?.blocking,
    panelLength: document.getElementById('room-length')?.textContent,
    guidance: document.getElementById('scan-guidance')?.textContent
  };
});

const nearTapped = (value, target, tol = 0.02) => typeof value === 'number' && Math.abs(value - target) <= tol;
check('plane detection really is unavailable in this run', tapped.planesSupported === false,
  `netSupport.planes=${tapped.planesSupported}`);
check('the room still measures its length', nearTapped(tapped.length, 4), `${tapped.length?.toFixed(3)} m`);
check('and its width', nearTapped(tapped.width, 3), `${tapped.width?.toFixed(3)} m`);
check('the floor area follows from the corners', nearTapped(tapped.area, 12, 0.05), `${tapped.area?.toFixed(2)} m2`);
check('and the perimeter agrees with 2(L+W)', nearTapped(tapped.perimeter, 14, 0.05), `${tapped.perimeter?.toFixed(2)} m`);
/* Height is optional on purpose: a ceiling is often featureless and hit-test
   returns nothing up there. Unmeasured must read as unmeasured, not as a
   typical ceiling — so it is null before the ceiling tap and only then real. */
check('height is null until the ceiling is actually tapped', tapped.heightBefore == null,
  String(tapped.heightBefore));
check('the ceiling tap gives the height', nearTapped(tapped.height, 2.5), `${tapped.height?.toFixed(2)} m`);
check('volume only exists once there is a height', nearTapped(tapped.volume, 30, 0.15),
  `${tapped.volume?.toFixed(2)} m3`);
check('one scan is not enough to use the room', tapped.firstReady === false);
check('it offers a confirming scan instead', /Scan again to confirm/.test(tapped.useRoomLabel || ''), tapped.useRoomLabel);
check('a corner on a table top is refused, not flattened', tapped.tableRefused === true);
check('a second scan 40 cm off is refused', tapped.afterDisagreement === false);
check('an agreeing second scan makes the room usable, with no sweep or walls', tapped.ready === true,
  `blocking: ${(tapped.blocking || []).join(', ')}`);
check('and the panel shows it', /^4\.0\d m$/.test(tapped.panelLength || ''), tapped.panelLength);
check('it calls two agreeing scans what they are', /Two scans agree/.test(tapped.guidance || ''), tapped.guidance);

/* The oversized case is covered exhaustively in tests/room.test.js against
   fitInRoom() directly; repeating it here would need a fake product in the
   catalogue, which is a worse test of the same arithmetic. */
console.log('  --   an oversized piece is covered by tests/room.test.js, which');
console.log('       exercises fitInRoom() directly rather than needing a fake');
console.log('       product in the live catalogue.');

console.log('  --   NOT covered here: plane detection, depth sensing, tracking');
console.log('       quality and real-world accuracy. Those need a physical');
console.log('       Android device and cannot be asserted from CI.');


console.log(errors.length ? `\n*** PAGE ERRORS ***\n${errors.join('\n')}` : '\nno page errors');
await browser.close();

if (errors.length) problems.push(`${errors.length} page error(s)`);
console.log(problems.length ? `\nFAILED: ${problems.join('; ')}` : '\nall planner checks passed');
process.exit(problems.length ? 1 : 0);
