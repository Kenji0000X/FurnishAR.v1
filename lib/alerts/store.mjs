/**
 * The one place FurnishAR raises a notification.
 *
 * Before this there were two private toast() functions — one in the store
 * portal, one inside the AR engine — each with its own element, its own timer
 * and its own idea of how long a message should stay, plus a handful of
 * inline "notice" banners that were really toasts in disguise. A message the
 * portal raised could not be raised from the planner, and two of them at once
 * simply overwrote each other.
 *
 * WHY A MODULE AND NOT A REACT CONTEXT
 * The planner's engine (app/plan/ar-engine.js) is vanilla JavaScript: it
 * builds its own DOM and has no access to React context. A Context-based
 * provider would have given every React page a notification system and left
 * the one place that most needs one — a camera that failed, a model that
 * would not load, a session that expired mid-scan — still on its own private
 * toast. A plain subscribable store is reachable from both, and the React
 * container simply subscribes to it. One queue, one renderer, many callers.
 *
 * WHAT IT GUARANTEES
 *   - No duplicates. The same message raised twice while it is still on
 *     screen refreshes the one already there rather than stacking a second.
 *   - Priority wins. Only a few alerts are shown at once, and a low-priority
 *     one can never push a critical one off the screen.
 *   - Nothing important vanishes on its own. Critical alerts stay until the
 *     person dismisses them; every timer pauses while the alert is hovered or
 *     focused, so it cannot disappear mid-read (WCAG 2.2.1).
 *   - One slot per operation. update() rewrites an alert in place, so
 *     "Loading…" becomes "Loaded" or "Failed" where it stood instead of
 *     stacking three messages for one event.
 *
 * This file must stay free of React and of the DOM so it can be imported by
 * the engine, by pages, and by node --test alike.
 */

export const TYPES = Object.freeze(['success', 'error', 'warning', 'info']);

/** Higher wins a place on screen. */
export const PRIORITY = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });

/** How long each kind stays, in ms, unless told otherwise. 0 = until dismissed. */
export const DEFAULT_DURATION = Object.freeze({
  success: 4000,
  info: 5000,
  warning: 7000,
  error: 9000
});

/** Sensible default priority by type, so callers rarely need to pass one. */
const DEFAULT_PRIORITY = Object.freeze({
  success: 'low',
  info: 'low',
  warning: 'medium',
  error: 'high'
});

/** Most alerts on screen at once. More than this is noise, not information. */
export const MAX_VISIBLE = 3;

const TITLES = Object.freeze({
  success: 'Done',
  error: 'Something needs attention',
  warning: 'Heads up',
  info: 'For your information'
});

let alerts = [];
let sequence = 0;
const listeners = new Set();
const timers = new Map();      // id -> { handle, remaining, startedAt }

/* A stable empty array for the server and first render, so
   useSyncExternalStore does not see a "new" snapshot on every call. */
const EMPTY = Object.freeze([]);

function emit() {
  for (const listener of listeners) listener(alerts);
}

function rank(alert) {
  return PRIORITY[alert.priority] ?? 0;
}

/**
 * Which alerts are actually shown: highest priority first, newest first
 * within a priority, capped at MAX_VISIBLE. Anything below the cut is
 * dropped rather than queued — a stale "Saved." arriving after the critical
 * message has been dismissed would describe a moment that has passed.
 */
function settle() {
  alerts = [...alerts]
    .sort((a, b) => rank(b) - rank(a) || b.createdAt - a.createdAt)
    .slice(0, MAX_VISIBLE);
  for (const id of [...timers.keys()]) {
    if (!alerts.some(alert => alert.id === id)) clearTimer(id);
  }
}

function clearTimer(id) {
  const timer = timers.get(id);
  if (timer?.handle) clearTimeout(timer.handle);
  timers.delete(id);
}

function startTimer(id, duration) {
  clearTimer(id);
  if (!duration || duration <= 0) return;
  const handle = setTimeout(() => dismiss(id), duration);
  timers.set(id, { handle, remaining: duration, startedAt: Date.now() });
}

function normalise(input) {
  const type = TYPES.includes(input.type) ? input.type : 'info';
  const priority = input.priority in PRIORITY ? input.priority : DEFAULT_PRIORITY[type];
  const duration = input.duration != null
    ? Number(input.duration)
    : (priority === 'critical' ? 0 : DEFAULT_DURATION[type]);
  const message = String(input.message ?? '').trim();
  return {
    type,
    priority,
    duration,
    title: input.title ? String(input.title) : TITLES[type],
    message,
    /* Actions must do something real: either a destination or a callback.
       One with neither is dropped here rather than rendered as a button
       that looks functional and is not. */
    actions: (input.actions || []).filter(action =>
      action && action.label && (action.href || typeof action.onAction === 'function')),
    dismissible: input.dismissible !== false,
    key: input.key ? String(input.key) : `${type}|${message}`
  };
}

/**
 * Raise an alert. Returns its id, which update() and dismiss() take.
 *
 * A message is required. An alert with nothing to say is the "Something went
 * wrong." this system exists to replace, so it is refused rather than shown.
 */
export function notify(input = {}) {
  const next = normalise(input);
  if (!next.message) return null;

  const existing = alerts.find(alert => alert.key === next.key);
  if (existing) {
    /* The same thing happened again while it is still on screen. Refresh
       the one that is there — do not stack a second copy of it. */
    Object.assign(existing, next, { id: existing.id, createdAt: Date.now(), repeats: existing.repeats + 1 });
    alerts = [...alerts];
    settle();
    startTimer(existing.id, existing.duration);
    emit();
    return existing.id;
  }

  const alert = { ...next, id: `alert-${++sequence}`, createdAt: Date.now(), repeats: 0 };
  alerts = [...alerts, alert];
  settle();
  if (alerts.some(item => item.id === alert.id)) startTimer(alert.id, alert.duration);
  emit();
  return alerts.some(item => item.id === alert.id) ? alert.id : null;
}

/**
 * Rewrite an alert in place. The way to turn "Loading 3D furniture…" into
 * its outcome without a second message appearing for the same operation.
 * Returns false when the alert has already gone.
 */
export function update(id, patch = {}) {
  const index = alerts.findIndex(alert => alert.id === id);
  if (index === -1) return false;
  const merged = normalise({ ...alerts[index], ...patch, key: patch.key || alerts[index].key });
  const alert = { ...alerts[index], ...merged, id, createdAt: Date.now() };
  alerts = alerts.map(item => (item.id === id ? alert : item));
  settle();
  startTimer(id, alert.duration);
  emit();
  return true;
}

export function dismiss(id) {
  const before = alerts.length;
  alerts = alerts.filter(alert => alert.id !== id);
  clearTimer(id);
  if (alerts.length !== before) emit();
}

export function clear() {
  for (const id of [...timers.keys()]) clearTimer(id);
  alerts = [];
  emit();
}

/** Stop the clock while someone is reading it. */
export function pause(id) {
  const timer = timers.get(id);
  if (!timer?.handle) return;
  clearTimeout(timer.handle);
  const elapsed = Date.now() - timer.startedAt;
  timers.set(id, { handle: null, remaining: Math.max(timer.remaining - elapsed, 1500), startedAt: 0 });
}

export function resume(id) {
  const timer = timers.get(id);
  if (!timer || timer.handle) return;
  const handle = setTimeout(() => dismiss(id), timer.remaining);
  timers.set(id, { handle, remaining: timer.remaining, startedAt: Date.now() });
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot() {
  return alerts;
}

export function getServerSnapshot() {
  return EMPTY;
}

/* ------------------------------------------------------------ shorthand --- */

export const showSuccess = (message, options = {}) => notify({ ...options, type: 'success', message });
export const showError = (message, options = {}) => notify({ ...options, type: 'error', message });
export const showWarning = (message, options = {}) => notify({ ...options, type: 'warning', message });
export const showInfo = (message, options = {}) => notify({ ...options, type: 'info', message });

/** For tests: start from nothing. */
export function __reset() {
  clear();
  sequence = 0;
  listeners.clear();
}
