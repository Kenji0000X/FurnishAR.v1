/**
 * How much is this measurement worth, and how many digits may it show?
 *
 * Two jobs that are really one. A grade nobody can act on is decoration, and
 * a number with more digits than the method can support is a lie told in
 * arithmetic — "3.427891 m" from a hand-held phone claims micrometres.
 *
 * ---------------------------------------------------------------------------
 * THE GRADE IS COMPUTED, NOT CHOSEN
 *
 * Every input below is something the device actually observed:
 *
 *   spread        the +/- band the method itself produces. For tilt this is
 *                 h*sec^2(theta)*dtheta, propagated in clinometer.mjs; for a
 *                 photo it is tap error scaled through the reference object.
 *   steadiness    peak-to-peak movement of the reading over the last window,
 *                 from Steadiness in smoothing.mjs.
 *   sensorHealth  the fraction of compass samples the glitch rejector threw
 *                 away, from HeadingTracker.
 *   agreement     where the same dimension was measured twice, how far apart
 *                 the two answers were.
 *
 * There is deliberately no "looks about right" term and no constant that was
 * chosen to make a demo read HIGH. If nothing was observed, the grade is
 * UNKNOWN — not MEDIUM, which is the comfortable lie in the middle.
 */

export const HIGH = 'high';
export const MEDIUM = 'medium';
export const LOW = 'low';
export const UNKNOWN = 'unknown';

/** What each grade means in plain words, for the interface to show. */
export const CONFIDENCE_COPY = {
  [HIGH]: { label: 'High', blurb: 'Steady reading from a method that suits this distance.' },
  [MEDIUM]: { label: 'Medium', blurb: 'Usable for planning. Check it with a tape before cutting anything.' },
  [LOW]: { label: 'Low', blurb: 'Treat this as a rough idea only.' },
  [UNKNOWN]: { label: 'Not measured', blurb: 'Nothing was observed to judge this by.' }
};

/**
 * The methods a dimension can come from. Carried with every value, because
 * "3.5 m" from a tape and "3.5 m" from a tilt reading are not the same claim
 * and the interface must be able to tell them apart.
 */
export const METHOD = {
  TILT: 'tilt',
  REFERENCE: 'reference-object',
  MANUAL: 'manual',
  DERIVED: 'derived'
};

export const METHOD_COPY = {
  [METHOD.TILT]: 'Tilt + gyroscope',
  [METHOD.REFERENCE]: 'Reference object',
  [METHOD.MANUAL]: 'Typed in',
  [METHOD.DERIVED]: 'Worked out from the others'
};

/*
   The thresholds, in metres of doubt.

   Anchored to what the number is FOR rather than to round figures. This app
   answers "will this sofa fit": a sofa arm is about 20 cm, so a band tighter
   than 5 cm cannot change a fit verdict and one wider than 20 cm can flip it
   either way.
*/
const HIGH_SPREAD = 0.05;
const LOW_SPREAD = 0.20;

/* Steadiness is in the same units as the reading it watched. Half a degree of
   combined angular movement is roughly 2 cm at 2.5 m. */
const STEADY_ENOUGH = 0.5;
const TOO_SHAKY = 2.0;

/**
 * Grade one measurement.
 *
 * Every argument is optional; each one that is missing simply cannot pull the
 * grade down, and if none is present the answer is UNKNOWN rather than a
 * default. Returns the grade, the reasons behind it, and the worst input, so
 * the interface can say WHY rather than just showing a word.
 */
export function gradeMeasurement({
  spread = null,
  steadiness = null,
  sensorHealth = null,
  agreement = null,
  method = null
} = {}) {
  /* Typed-in figures are not graded by sensors, because no sensor was
     involved. They are as good as the tape that produced them, which is
     better than anything else here — but the app cannot verify them, so
     they are reported as what they are rather than as HIGH. */
  if (method === METHOD.MANUAL) {
    return {
      grade: HIGH, method, reasons: ['You measured this yourself.'], worst: null
    };
  }

  const reasons = [];
  const scores = [];

  if (spread !== null && Number.isFinite(spread)) {
    if (spread <= HIGH_SPREAD) scores.push({ s: 3, why: `within ±${Math.round(spread * 100)} cm` });
    else if (spread <= LOW_SPREAD) scores.push({ s: 2, why: `give or take ${Math.round(spread * 100)} cm` });
    else scores.push({ s: 1, why: `give or take ${Math.round(spread * 100)} cm, which is too loose to plan with` });
  }

  if (steadiness !== null && Number.isFinite(steadiness)) {
    if (steadiness <= STEADY_ENOUGH) scores.push({ s: 3, why: 'the phone was steady' });
    else if (steadiness <= TOO_SHAKY) scores.push({ s: 2, why: 'the phone moved a little' });
    else scores.push({ s: 1, why: 'the phone was moving while this was taken' });
  }

  if (sensorHealth !== null && Number.isFinite(sensorHealth)) {
    // sensorHealth is the fraction of samples REJECTED, so lower is better.
    if (sensorHealth <= 0.08) scores.push({ s: 3, why: 'the compass was behaving' });
    else if (sensorHealth <= 0.25) scores.push({ s: 2, why: 'the compass was unsteady' });
    else scores.push({ s: 1, why: 'the compass was jumping — something magnetic is nearby' });
  }

  if (agreement !== null && Number.isFinite(agreement)) {
    if (agreement <= 0.05) scores.push({ s: 3, why: 'two readings agreed' });
    else if (agreement <= 0.20) scores.push({ s: 2, why: `two readings differed by ${Math.round(agreement * 100)} cm` });
    else scores.push({ s: 1, why: `two readings differed by ${Math.round(agreement * 100)} cm, which is too much to reconcile` });
  }

  if (!scores.length) {
    return { grade: UNKNOWN, method, reasons: ['Nothing was observed to judge this by.'], worst: null };
  }

  /* The WEAKEST link decides. Averaging would let a rock-steady hold hide a
     compass that was jumping, and the resulting number would be wrong in a
     way the grade had quietly excused. */
  const worst = scores.reduce((a, b) => (b.s < a.s ? b : a));
  for (const s of scores) reasons.push(s.why);

  return {
    grade: worst.s === 3 ? HIGH : worst.s === 2 ? MEDIUM : LOW,
    method,
    reasons,
    worst: worst.why
  };
}

/**
 * How many digits this measurement has earned.
 *
 * Precision follows the doubt, so the display never claims more than the
 * method delivered. A ±40 cm reading shown as "3.43 m" invites someone to
 * order a sofa on a figure that could be 3.0 or 3.8.
 */
export function formatMeasurement(metres, { spread = null, grade = null } = {}) {
  if (metres === null || !Number.isFinite(metres)) {
    return { text: 'Measurement unavailable', decimals: null, approximate: true };
  }

  const band = spread ?? (grade === HIGH ? 0.03 : grade === MEDIUM ? 0.12 : grade === LOW ? 0.4 : null);

  // Under 5 cm of doubt, centimetres are real and worth showing.
  if (band !== null && band <= 0.05) {
    return { text: `${metres.toFixed(2)} m`, decimals: 2, approximate: false };
  }
  // Under 20 cm, the first decimal is meaningful and the second is not.
  if (band !== null && band <= 0.20) {
    return { text: `≈ ${metres.toFixed(1)} m`, decimals: 1, approximate: true };
  }
  /* Past that, round to the nearest ten centimetres and say so. Showing
     "3.4 m" for something that could be 3.0 still overstates it. */
  if (band !== null) {
    return {
      text: `≈ ${(Math.round(metres * 10) / 10).toFixed(1)} m`,
      decimals: 1, approximate: true,
      note: `give or take ${Math.round(band * 100)} cm`
    };
  }
  return { text: `${metres.toFixed(2)} m`, decimals: 2, approximate: false };
}

/**
 * Do two measurements of the same thing agree?
 *
 * Used where a dimension is taken twice — two opposite walls for a room's
 * width, say. Disagreement is not averaged away: a room whose two "widths"
 * differ by 40 cm is not a rectangle, and saying so is more useful than
 * quietly reporting the mean of two numbers, one of which is wrong.
 */
export function reconcile(a, b, { tolerance = 0.10 } = {}) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return { value: Number.isFinite(a) ? a : Number.isFinite(b) ? b : null, agreement: null, rectangular: null };
  }
  const agreement = Math.abs(a - b);
  const value = (a + b) / 2;
  if (agreement > tolerance) {
    return {
      value, agreement, rectangular: false,
      warning: `Those two walls differ by ${Math.round(agreement * 100)} cm. The room may not be square, or one reading was off — check both before relying on it.`
    };
  }
  return { value, agreement, rectangular: true };
}
