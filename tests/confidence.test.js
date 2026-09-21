import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gradeMeasurement, formatMeasurement, reconcile,
  HIGH, MEDIUM, LOW, UNKNOWN, METHOD, CONFIDENCE_COPY
} from '../lib/spatial/confidence.mjs';

test('nothing observed is UNKNOWN, not a comfortable MEDIUM', () => {
  const { grade, reasons } = gradeMeasurement({});
  assert.equal(grade, UNKNOWN);
  assert.match(reasons[0], /Nothing was observed/);
});

test('a tight, steady reading on a healthy compass is HIGH', () => {
  const { grade } = gradeMeasurement({ spread: 0.03, steadiness: 0.2, sensorHealth: 0.01 });
  assert.equal(grade, HIGH);
});

test('the weakest input decides, so one bad signal cannot be averaged away', () => {
  /*
     The failure this prevents: a rock-steady hold beside an electrical meter
     box. Three good numbers and one terrible one average to "fine", and the
     resulting measurement is wrong in exactly the way the grade excused.
  */
  const { grade, worst } = gradeMeasurement({
    spread: 0.02, steadiness: 0.1, sensorHealth: 0.9
  });
  assert.equal(grade, LOW);
  assert.match(worst, /compass was jumping/);
});

test('a loose spread alone drags the grade down', () => {
  assert.equal(gradeMeasurement({ spread: 0.45, steadiness: 0.1 }).grade, LOW);
  assert.equal(gradeMeasurement({ spread: 0.12, steadiness: 0.1 }).grade, MEDIUM);
});

test('typed-in figures are not graded by sensors that were never used', () => {
  const { grade, reasons } = gradeMeasurement({ method: METHOD.MANUAL, sensorHealth: 0.99 });
  assert.equal(grade, HIGH);
  assert.match(reasons[0], /You measured this yourself/);
});

test('every grade has words a person can act on', () => {
  for (const g of [HIGH, MEDIUM, LOW, UNKNOWN]) {
    assert.ok(CONFIDENCE_COPY[g].label.length > 2);
    assert.ok(CONFIDENCE_COPY[g].blurb.length > 10);
  }
});

/* --------------------------------------------------------- false precision */

test('centimetres are shown only when they are real', () => {
  const tight = formatMeasurement(3.4278, { spread: 0.03 });
  assert.equal(tight.text, '3.43 m');
  assert.equal(tight.approximate, false);
});

test('a soft reading loses a digit and gains a tilde', () => {
  const soft = formatMeasurement(3.4278, { spread: 0.15 });
  assert.equal(soft.text, '≈ 3.4 m');
  assert.equal(soft.approximate, true);
});

test('a very soft reading says how soft, instead of implying centimetres', () => {
  /*
     The specific lie being prevented: "3.43 m" from a reading that could be
     anywhere from 3.0 to 3.8. Somebody orders a sofa on that.
  */
  const rough = formatMeasurement(3.4278, { spread: 0.4 });
  assert.equal(rough.text, '≈ 3.4 m');
  assert.match(rough.note, /give or take 40 cm/);
});

test('no value means no number, not a zero', () => {
  const none = formatMeasurement(null);
  assert.equal(none.text, 'Measurement unavailable');
  assert.equal(none.decimals, null);
});

test('precision can fall back to the grade when no spread is known', () => {
  assert.equal(formatMeasurement(2.5, { grade: HIGH }).text, '2.50 m');
  assert.equal(formatMeasurement(2.5, { grade: MEDIUM }).text, '≈ 2.5 m');
});

/* ------------------------------------------------------------ two readings */

test('two walls that agree are averaged and called rectangular', () => {
  const r = reconcile(3.40, 3.44);
  assert.ok(Math.abs(r.value - 3.42) < 1e-9);
  assert.equal(r.rectangular, true);
  assert.equal(r.warning, undefined);
});

test('two walls that disagree are flagged, not quietly averaged', () => {
  /*
     A room whose two "widths" differ by 40 cm is not a rectangle. Reporting
     the mean hides that; saying so lets the person find out which reading
     was wrong, or accept that the room is irregular.
  */
  const r = reconcile(3.20, 3.60);
  assert.equal(r.rectangular, false);
  assert.match(r.warning, /differ by 40 cm/);
  assert.match(r.warning, /may not be square/);
});

test('one missing reading is passed through rather than halved', () => {
  assert.equal(reconcile(3.2, null).value, 3.2);
  assert.equal(reconcile(null, 3.6).value, 3.6);
  assert.equal(reconcile(null, null).value, null);
});
