import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  notify, update, dismiss, pause, resume, subscribe, getSnapshot, __reset,
  showSuccess, showError, MAX_VISIBLE, DEFAULT_DURATION
} from '../lib/alerts/store.mjs';
import { CATALOG, catalog, describeStatus, describeError } from '../lib/alerts/messages.mjs';

beforeEach(() => __reset());

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('an alert with nothing to say is refused, not shown', () => {
  /* "Something went wrong." with nothing after it is the message this
     system exists to replace; an empty one is worse. */
  assert.equal(notify({ type: 'error', message: '' }), null);
  assert.equal(notify({ type: 'error', message: '   ' }), null);
  assert.equal(getSnapshot().length, 0);
});

test('the same message twice is one alert, not two', () => {
  const first = showError('Connection failed.');
  const second = showError('Connection failed.');
  assert.equal(first, second);
  assert.equal(getSnapshot().length, 1);
  assert.equal(getSnapshot()[0].repeats, 1);
});

test('different types with the same text are different alerts', () => {
  showError('Saved.');
  showSuccess('Saved.');
  assert.equal(getSnapshot().length, 2);
});

test('a low-priority alert can never push a critical one off the screen', () => {
  notify({ type: 'warning', priority: 'critical', message: 'Your session has expired.' });
  for (let i = 0; i < MAX_VISIBLE + 3; i++) showSuccess(`Saved item ${i}.`);
  const shown = getSnapshot();
  assert.equal(shown.length, MAX_VISIBLE);
  assert.ok(shown.some(alert => alert.priority === 'critical'),
    'the critical alert is still on screen');
  assert.equal(shown[0].priority, 'critical', 'and it is first');
});

test('critical alerts stay until dismissed; others have a clock', () => {
  const critical = notify({ type: 'warning', priority: 'critical', message: 'Session expired.' });
  const ordinary = showSuccess('Saved.');
  const byId = id => getSnapshot().find(alert => alert.id === id);
  assert.equal(byId(critical).duration, 0);
  assert.equal(byId(ordinary).duration, DEFAULT_DURATION.success);
});

test('an alert leaves on its own when its time is up', async () => {
  notify({ type: 'info', message: 'Measuring…', duration: 40 });
  assert.equal(getSnapshot().length, 1);
  await wait(90);
  assert.equal(getSnapshot().length, 0);
});

test('hovering or focusing an alert stops it leaving mid-read', async () => {
  const id = notify({ type: 'info', message: 'Read me slowly.', duration: 60 });
  pause(id);
  await wait(120);
  assert.equal(getSnapshot().length, 1, 'still there while paused');
  resume(id);
  /* Resuming gives back at least 1.5s so a reader is never cut off the
     instant they look away. */
  assert.equal(getSnapshot().length, 1);
});

test('update() rewrites one slot instead of stacking a second message', () => {
  const id = notify({ type: 'info', message: 'Loading 3D furniture…', duration: 0 });
  update(id, { type: 'success', message: '3D model loaded.' });
  const shown = getSnapshot();
  assert.equal(shown.length, 1);
  assert.equal(shown[0].type, 'success');
  assert.equal(shown[0].message, '3D model loaded.');
});

test('actions that do nothing are dropped rather than drawn', () => {
  notify({
    type: 'error', message: 'Failed.',
    actions: [{ label: 'Try again' }, { label: 'Sign in', href: '/login' }, { label: 'Retry', onAction: () => {} }]
  });
  assert.deepEqual(getSnapshot()[0].actions.map(a => a.label), ['Sign in', 'Retry']);
});

test('subscribers hear every change, and dismiss() removes the alert', () => {
  let heard = 0;
  subscribe(() => { heard += 1; });
  const id = showSuccess('Room saved.');
  dismiss(id);
  assert.equal(heard, 2);
  assert.equal(getSnapshot().length, 0);
});

test('every catalog entry says something and names its type', () => {
  for (const [key, entry] of Object.entries(CATALOG)) {
    assert.ok(['success', 'error', 'warning', 'info'].includes(entry.type), `${key} type`);
    assert.ok(entry.message && entry.message.length > 8, `${key} has a real message`);
    assert.doesNotMatch(entry.message, /^something went wrong\.?$/i, `${key} is not the bare apology`);
  }
});

test('catalog() refuses a key that does not exist rather than showing nothing', () => {
  assert.throws(() => catalog('no.such.alert'), /Unknown alert/);
});

test('HTTP statuses read as what happened, never as the code', () => {
  for (const status of [400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504]) {
    const { message } = describeStatus(status, '3D model');
    assert.ok(message.length > 10, `${status} has a sentence`);
    assert.doesNotMatch(message, /\b\d{3}\b/, `${status} does not leak the code`);
  }
  assert.match(describeStatus(401).message, /session has expired/i);
  assert.match(describeStatus(403, '3D model').message, /permission/i);
  assert.match(describeStatus(404, 'furniture').message, /furniture could not be found/i);
  assert.match(describeStatus(429).message, /too many requests/i);
});

test('a dead network and a timeout are named for what they are', () => {
  assert.match(describeError(new TypeError('Failed to fetch')).message, /connection failed/i);
  const timeout = new Error('timed out'); timeout.name = 'AbortError';
  assert.match(describeError(timeout).message, /too long/i);
  const forbidden = new Error('x'); forbidden.status = 403;
  assert.match(describeError(forbidden, '3D model').message, /permission/i);
});
