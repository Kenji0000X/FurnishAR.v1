/**
 * Typing a room by hand. The field regression: 90, 100 and 600 typed into
 * "metres" meaning centimetres must not become a 90 x 100 m room.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  roomToMetres, roomFromMetres, roomInputValue, formatRoomLength, roomDimensionProblem,
  manualRoom, convertRoomFields, isRoomUnit
} from '../lib/spatial/room-units.mjs';

test('conversions', () => {
  assert.equal(roomToMetres(420, 'cm'), 4.2);
  assert.ok(Math.abs(roomToMetres(10, 'ft') - 3.048) < 1e-12);
  assert.ok(Math.abs(roomToMetres(120, 'in') - 3.048) < 1e-12);
  assert.ok(Math.abs(roomFromMetres(4.2, 'cm') - 420) < 1e-9);
  assert.equal(formatRoomLength(4.2, 'm'), '4.2 m');
  assert.equal(formatRoomLength(4.2, 'cm'), '420 cm');
  assert.equal(isRoomUnit('m'), true);
  assert.equal(isRoomUnit('yd'), false);
  assert.throws(() => roomToMetres(1, 'yd'), RangeError);
});

test('the field regression: 90 / 100 / 600 in metres is refused, with the unit named', () => {
  const r = manualRoom({ length: '90', width: '100', height: '600' }, 'm');
  assert.equal(r.ready, false);
  assert.equal(r.problems.length.level, 'error');
  assert.match(r.problems.length.message, /90 m is far too large for a room\. Check the selected unit\./);
  assert.equal(r.problems.height.level, 'error');
  assert.equal(r.suggestUnit, 'cm', 'offers the unit the person meant, judged on all three fields');
});

test('…and in centimetres the same digits are 0.90, 1.00 and 6.00 m, confirmed before use', () => {
  const r = manualRoom({ length: '90', width: '100', height: '600' }, 'cm');
  assert.ok(Math.abs(r.metres.length - 0.9) < 1e-12);
  assert.ok(Math.abs(r.metres.width - 1.0) < 1e-12);
  assert.ok(Math.abs(r.metres.height - 6.0) < 1e-12);
  // 0.9 m of length and a 6 m ceiling are unusual: shown, and confirmed.
  assert.equal(r.needsConfirmation, true);
  assert.equal(r.ready, false);
  assert.equal(manualRoom({ length: '90', width: '100', height: '600' }, 'cm', { confirmed: true }).ready, true);
});

test('an ordinary room needs no confirmation', () => {
  const r = manualRoom({ length: '4.2', width: '3.1', height: '2.7' }, 'm');
  assert.equal(r.ready, true);
  assert.equal(r.needsConfirmation, false);
  assert.equal(manualRoom({ length: '14', width: '10', height: '' }, 'ft').ready, true);
});

test('600 m is warned about as the brief words it', () => {
  // Length 20 m: past normal, under the hard limit -> a warning, not a refusal.
  const p = roomDimensionProblem('20', 'm', 'length');
  assert.equal(p.level, 'warning');
  assert.equal(p.message, '20 m is unusually large for a room. Check the selected unit.');
  assert.equal(roomDimensionProblem('600', 'm', 'length').level, 'error');
});

test('switching unit converts the value and never reinterprets it', () => {
  const inFeet = convertRoomFields({ length: '420', width: '310', height: '' }, 'cm', 'ft');
  assert.equal(inFeet.height, '');
  assert.ok(Math.abs(roomToMetres(Number(inFeet.length), 'ft') - 4.2) < 0.001);
  const back = convertRoomFields(inFeet, 'ft', 'cm');
  assert.equal(back.length, '420');
  assert.equal(back.width, '310');
  assert.equal(roomInputValue(4.2, 'm'), '4.2');
});

test('bad input is an error, never a silent clamp', () => {
  assert.equal(roomDimensionProblem('', 'm', 'length').level, 'error');
  assert.equal(roomDimensionProblem('', 'm', 'height'), null, 'height is optional');
  assert.equal(roomDimensionProblem('abc', 'm', 'width').level, 'error');
  assert.equal(roomDimensionProblem('-3', 'm', 'width').level, 'error');
});
