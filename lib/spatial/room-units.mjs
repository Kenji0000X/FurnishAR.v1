/**
 * Room sizes typed in by hand: one unit, converted, and checked for sense.
 *
 * Field testing typed 90, 100 and 600 into fields labelled "in metres" — the
 * person meant centimetres — and the planner built a 90 × 100 m room with a
 * 600 m ceiling without a word. Two fixes:
 *
 *   1. The unit is chosen, visible, and applies to all three fields. Changing
 *      it converts what is typed: 420 cm becomes 4.2 m, never 420 m.
 *   2. Every value is checked against what a room can be. Implausible values
 *      are warned about and must be confirmed; impossible ones are refused.
 *      Nothing is silently clamped.
 *
 * Internally everything is metres. Furniture sizes are centimetres and have
 * their own module (units.mjs); rooms and furniture never share a unit list,
 * because "ft" on a sofa and "m" on a room are both the right defaults.
 */

export const ROOM_UNITS = Object.freeze([
  { id: 'm', label: 'metres', short: 'm', metres: 1, digits: 2 },
  { id: 'cm', label: 'centimetres', short: 'cm', metres: 0.01, digits: 0 },
  { id: 'ft', label: 'feet', short: 'ft', metres: 0.3048, digits: 2 },
  { id: 'in', label: 'inches', short: 'in', metres: 0.0254, digits: 1 }
]);

const byId = Object.fromEntries(ROOM_UNITS.map(u => [u.id, u]));

export function isRoomUnit(unit) { return Object.hasOwn(byId, unit); }

function unitOf(id) {
  const unit = byId[id];
  if (!unit) throw new RangeError(`Unknown room unit: ${id}`);
  return unit;
}

export function roomToMetres(value, unit) { return Number(value) * unitOf(unit).metres; }
export function roomFromMetres(metres, unit) { return metres / unitOf(unit).metres; }

/** What a field shows for a length held in metres. Enough digits to round-trip. */
export function roomInputValue(metres, unit) {
  if (!Number.isFinite(metres)) return '';
  const u = unitOf(unit);
  const value = roomFromMetres(metres, unit);
  return String(Number(value.toFixed(u.digits + 1)));
}

export function formatRoomLength(metres, unit = 'm') {
  if (!Number.isFinite(metres)) return '—';
  const u = unitOf(unit);
  return `${Number(roomFromMetres(metres, unit).toFixed(u.digits))} ${u.short}`;
}

/**
 * What a room dimension may be, in metres.
 *
 *   normal     no comment
 *   warning    possible but unusual: shown, and must be confirmed before use
 *   hard       outside this the value is refused outright
 *
 * Household rooms in the pilot area run roughly 2 to 8 m a side with 2.4 to
 * 3.5 m ceilings; the warning bands leave generous room for halls and
 * showrooms, and the hard limits are where a number stops being a room.
 */
export const ROOM_LIMITS = Object.freeze({
  length: { normal: [1.0, 15], hard: [0.3, 50] },
  width: { normal: [1.0, 15], hard: [0.3, 50] },
  height: { normal: [2.0, 4.5], hard: [1.0, 10] }
});

const AXIS_LABEL = { length: 'Length', width: 'Width', height: 'Height' };

/**
 * Is this typed value a sensible room dimension?
 *
 * Returns null when it is, or { level: 'error' | 'warning', message, suggest }
 * — `suggest` naming the unit the value WOULD make sense in, when there is
 * one, so the interface can offer the fix in one tap.
 */
export function roomDimensionProblem(value, unit, axis) {
  const limits = ROOM_LIMITS[axis];
  const label = AXIS_LABEL[axis] || 'This size';
  const text = typeof value === 'string' ? value.trim() : value;
  if (text === '' || text === null || text === undefined) {
    return axis === 'height' ? null : { level: 'error', message: `${label} is needed.` };
  }
  const number = Number(text);
  if (!Number.isFinite(number)) return { level: 'error', message: `${label} needs to be a number.` };
  if (number <= 0) return { level: 'error', message: `${label} must be more than zero.` };

  const metres = roomToMetres(number, unit);
  const written = `${text} ${unitOf(unit).short}`;
  const suggest = ROOM_UNITS
    .filter(u => u.id !== unit)
    .find(u => {
      const m = roomToMetres(number, u.id);
      return m >= limits.normal[0] && m <= limits.normal[1];
    })?.id ?? null;

  const [hardMin, hardMax] = limits.hard;
  const [normMin, normMax] = limits.normal;
  if (metres > hardMax) {
    return { level: 'error', message: `${written} is far too large for a room. Check the selected unit.`, suggest };
  }
  if (metres < hardMin) {
    return { level: 'error', message: `${written} is too small for a room. Check the selected unit.`, suggest };
  }
  if (metres > normMax) {
    return { level: 'warning', message: `${written} is unusually large for a room. Check the selected unit.`, suggest };
  }
  if (metres < normMin) {
    return { level: 'warning', message: `${written} is unusually small for a room. Check the selected unit.`, suggest };
  }
  return null;
}

/**
 * All three fields at once. `ready` only when nothing is refused and every
 * warning has been confirmed by the person.
 */
export function manualRoom({ length, width, height }, unit, { confirmed = false } = {}) {
  const problems = {
    length: roomDimensionProblem(length, unit, 'length'),
    width: roomDimensionProblem(width, unit, 'width'),
    height: roomDimensionProblem(height, unit, 'height')
  };
  const list = Object.values(problems).filter(Boolean);
  const errors = list.filter(p => p.level === 'error');
  const warnings = list.filter(p => p.level === 'warning');
  const metres = {
    length: String(length).trim() === '' ? null : roomToMetres(length, unit),
    width: String(width).trim() === '' ? null : roomToMetres(width, unit),
    height: height === undefined || String(height).trim() === '' ? null : roomToMetres(height, unit)
  };
  return {
    problems,
    metres,
    suggestUnit: errors.length || warnings.length ? suggestUnit({ length, width, height }, unit) : null,
    /* Shown whenever there is something to confirm, ticked or not, so the
       confirmation can be undone. */
    confirmable: errors.length === 0 && warnings.length > 0,
    needsConfirmation: errors.length === 0 && warnings.length > 0 && !confirmed,
    ready: errors.length === 0 && (warnings.length === 0 || confirmed)
  };
}

/**
 * The unit in which what was typed makes the most sense as a room, judged on
 * all three fields together: 90 / 100 / 600 is impossible in metres and in
 * inches (a 15 m ceiling), and an ordinary small room in centimetres. Null
 * when no other unit is clearly better.
 */
export function suggestUnit(fields, current) {
  const score = unit => {
    let errors = 0, normal = 0;
    for (const axis of ['length', 'width', 'height']) {
      const text = fields[axis];
      if (text === undefined || String(text).trim() === '') continue;
      const problem = roomDimensionProblem(text, unit, axis);
      if (!problem) normal += 1;
      else if (problem.level === 'error') errors += 1;
    }
    return { unit, errors, normal };
  };
  const here = score(current);
  const best = ROOM_UNITS.filter(u => u.id !== current).map(u => score(u.id))
    .filter(s => s.errors === 0)
    .sort((a, b) => b.normal - a.normal)[0];
  if (!best) return null;
  return best.errors < here.errors || best.normal > here.normal ? best.unit : null;
}

/** Convert what is typed when the unit changes. Invalid text is left alone. */
export function convertRoomFields(fields, fromUnit, toUnit) {
  const out = {};
  for (const [key, text] of Object.entries(fields)) {
    const n = Number(String(text).trim());
    out[key] = String(text).trim() !== '' && Number.isFinite(n) && n > 0
      ? roomInputValue(roomToMetres(n, fromUnit), toUnit)
      : text;
  }
  return out;
}
