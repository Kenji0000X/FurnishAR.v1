/**
 * The recommendation router (lib/spatial/capabilities.mjs recommendExperience):
 * deterministic, from observed facts, and AI only ever as another dimension.
 * The facts are the shapes /diagnose records on the tested phones; the
 * physical results themselves stay NOT TESTED in docs/AR-DEVICE-MATRIX.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCapabilities, recommendExperience, LEVEL, MEASURE_METHOD, DIAG } from '../lib/spatial/capabilities.mjs';
import { AI_VISION } from '../lib/spatial/ai/config.mjs';

const android = { secureContext: true, platform: 'android', browserFamily: 'chrome', inAppBrowser: null, webgl: true, webxr: true, cameraApi: true };
const trackedOk = { ...android, immersiveArAdvertised: true, sessionStarted: true, hitTestVerified: true, frames: 180, hitFrames: 120, trackedFrameRatio: 0.97 };
const sensors = { cameraOpened: true, orientationEvents: 200, orientationRate: 50, headingVerdict: 'noisy' };
const level = facts => assessCapabilities(facts).recommendation;

test('Infinix-shaped facts: verified tracking is Tracked AR, with no AI needed', () => {
  const r = level({ ...trackedOk, ...sensors });
  assert.equal(r.level, LEVEL.TRACKED_AR);
  assert.equal(r.confirmed, true);
  assert.equal(r.product, 'tracked');
  assert.equal(r.fallback, LEVEL.PHOTO_MEASUREMENT);
  assert.match(r.reason, /Tracked AR works on this phone/);
});

test('Tracked AR+ needs stable tracking AND a verified enhancement', () => {
  assert.equal(level({ ...trackedOk, ...sensors, aiMode: AI_VISION.REALTIME }).level, LEVEL.TRACKED_AR_PLUS);
  assert.equal(level({ ...trackedOk, ...sensors, aiMode: AI_VISION.GPU }).level, LEVEL.TRACKED_AR_PLUS);
  assert.equal(level({ ...trackedOk, ...sensors, planesObserved: 2 }).level, LEVEL.TRACKED_AR_PLUS);
  assert.equal(level({ ...trackedOk, ...sensors, aiMode: AI_VISION.SINGLE_FRAME }).level, LEVEL.TRACKED_AR,
    'a single-frame AI is not a live enhancement');
  const shaky = level({ ...trackedOk, trackedFrameRatio: 0.5, aiMode: AI_VISION.GPU });
  assert.equal(shaky.level, LEVEL.TRACKED_AR, 'unstable tracking is never "plus"');
  assert.match(shaky.reason, /tracking dropped out/);
});

test('advertised is not verified: Tracked AR is offered but not confirmed', () => {
  const r = level({ ...android, immersiveArAdvertised: true });
  assert.equal(r.level, LEVEL.TRACKED_AR);
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /Run the AR check/);
});

test('AI NEVER makes WebXR supported', () => {
  const noXr = { ...android, webxr: false, immersiveArAdvertised: false, ...sensors, aiMode: AI_VISION.GPU };
  const a = assessCapabilities(noXr);
  assert.equal(a.trackedVerified, false);
  assert.equal(a.trackedWorthTrying, false);
  assert.notEqual(a.recommendation.level, LEVEL.TRACKED_AR);
  assert.notEqual(a.recommendation.level, LEVEL.TRACKED_AR_PLUS);
  assert.notEqual(a.recommendation.product, 'tracked');
  // A refused session stays refused, however fast the AI is.
  const refused = assessCapabilities({ ...android, immersiveArAdvertised: true, sessionError: { state: DIAG.AR_SESSION_REFUSED }, ...sensors, aiMode: AI_VISION.GPU });
  assert.equal(refused.trackedState, DIAG.AR_SESSION_REFUSED);
  assert.notEqual(refused.recommendation.product, 'tracked');
});

test('TECNO-shaped facts: session refused, camera + tilt + real-time AI gives AI-assisted measurement', () => {
  const facts = { ...android, immersiveArAdvertised: true, sessionError: { state: DIAG.AR_SESSION_REFUSED }, ...sensors };
  const r = level({ ...facts, aiMode: AI_VISION.REALTIME });
  assert.equal(r.level, LEVEL.AI_ASSISTED_MEASUREMENT);
  assert.equal(r.aiGuidance, true);
  assert.equal(r.product, 'untracked-preview', 'never world-anchored furniture');
  assert.equal(r.fallback, LEVEL.PHOTO_MEASUREMENT);
  assert.match(r.reason, /Tracked AR isn’t available here, but AI-assisted measurement works/);
});

test('single-frame AI gives photo measurement WITH suggestions; no AI gives plain photo', () => {
  const facts = { ...android, immersiveArAdvertised: false, ...sensors };
  const withStill = level({ ...facts, aiMode: AI_VISION.SINGLE_FRAME });
  assert.equal(withStill.level, LEVEL.PHOTO_MEASUREMENT);
  assert.equal(withStill.photoSuggestions, true);
  assert.equal(withStill.fallback, LEVEL.MANUAL);
  const none = level({ ...facts, aiMode: AI_VISION.NONE });
  assert.equal(none.level, LEVEL.PHOTO_MEASUREMENT);
  assert.equal(none.photoSuggestions, false);
  assert.match(none.reason, /Photo measurement is the best option on this phone\.$/);
});

test('real-time AI without a usable tilt sensor is not AI-assisted measurement', () => {
  const r = level({ ...android, immersiveArAdvertised: false, cameraOpened: true, orientationEvents: 0, aiMode: AI_VISION.GPU });
  assert.equal(r.level, LEVEL.PHOTO_MEASUREMENT, 'no sensor, no scale from phone height');
});

test('AI failing or untested removes nothing: the same methods either way', () => {
  const facts = { ...android, immersiveArAdvertised: false, ...sensors };
  const untested = assessCapabilities(facts);
  const failed = assessCapabilities({ ...facts, aiMode: AI_VISION.NONE });
  assert.deepEqual(failed.measurementMethods, untested.measurementMethods);
  assert.ok(failed.measurementMethods.includes(MEASURE_METHOD.MANUAL));
  assert.equal(untested.aiMode, null, 'not tested is null, not "none"');
});

test('no camera: tape measure, which is not an error state', () => {
  const r = level({ ...android, immersiveArAdvertised: false, cameraOpened: false });
  assert.equal(r.level, LEVEL.MANUAL);
  assert.equal(r.fallback, null);
  assert.match(r.reason, /most accurate/);
});

test('iPhone: Quick Look for furniture, room by another method', () => {
  const ios = { secureContext: true, platform: 'ios', browserFamily: 'safari', inAppBrowser: null, webgl: true, webxr: false, cameraApi: true, ...sensors };
  const eligible = level({ ...ios, iosQuickLookEligible: true });
  assert.equal(eligible.product, 'quick-look');
  assert.equal(eligible.room, LEVEL.PHOTO_MEASUREMENT);
  assert.notEqual(eligible.level, LEVEL.TRACKED_AR, 'Safari is never treated as Android WebXR');
  assert.equal(level({ ...ios, iosQuickLookEligible: false }).product, 'untracked-preview');
  assert.equal(level({ ...ios, iosQuickLookEligible: true, aiMode: AI_VISION.REALTIME }).room, LEVEL.AI_ASSISTED_MEASUREMENT);
});

test('Messenger and insecure pages: fix the context first', () => {
  assert.equal(level({ ...trackedOk, inAppBrowser: 'messenger' }).level, LEVEL.OPEN_EXTERNAL_BROWSER);
  assert.equal(level({ ...trackedOk, inAppBrowser: 'messenger' }).reason, 'Open FurnishAR in Chrome first.');
  assert.equal(level({ ...android, secureContext: false }).level, LEVEL.OPEN_SECURE_ADDRESS);
});

test('recommendExperience alone gives the same answer as through assessCapabilities', () => {
  const facts = { ...trackedOk, ...sensors, aiMode: AI_VISION.REALTIME };
  assert.deepEqual(recommendExperience(facts), assessCapabilities(facts).recommendation);
});
