/**
 * Each observed situation reaches the right experience. The user agents are
 * the shapes the tested phones report; the facts are what the device check
 * and the planner actually observe.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  browserContext, browserHandoff, assessCapabilities, classifyRefusal, sessionInit,
  minimalSessionInit, diagnosticReport, DIAG, EXPERIENCE, MEASURE_METHOD
} from '../lib/spatial/capabilities.mjs';

const UA = {
  infinixChrome: 'Mozilla/5.0 (Linux; Android 14; Infinix X6728) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  tecnoChrome: 'Mozilla/5.0 (Linux; Android 12; TECNO KI5k) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
  vivoChrome: 'Mozilla/5.0 (Linux; Android 10; vivo 1906) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36',
  reducedChrome: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  messengerAndroid: 'Mozilla/5.0 (Linux; Android 14; Infinix X6728 Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.0.0 Mobile Safari/537.36 [FB_IAB/Orca-Android;FBAV/480.0.0.0;]',
  messengerIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/MessengerForiOS;FBAV/470.0]',
  facebookAndroid: 'Mozilla/5.0 (Linux; Android 12; TECNO KI5k Build/SP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/475.0.0.0;]',
  plainWebView: 'Mozilla/5.0 (Linux; Android 10; vivo 1906; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/127.0.0.0 Mobile Safari/537.36'
};

test('browser context: model, platform and embedded browsers', () => {
  const infinix = browserContext(UA.infinixChrome);
  assert.equal(infinix.platform, 'android');
  assert.equal(infinix.browserFamily, 'chrome');
  assert.equal(infinix.inAppBrowser, null);
  assert.equal(infinix.deviceModel, 'Infinix X6728');
  assert.equal(browserContext(UA.reducedChrome).deviceModel, null, 'a reduced UA is unknown, not guessed');
  assert.equal(browserContext(UA.iphoneSafari).platform, 'ios');
  assert.equal(browserContext(UA.iphoneSafari).browserFamily, 'safari');
  assert.equal(browserContext(UA.messengerAndroid).inAppBrowser, 'messenger');
  assert.equal(browserContext(UA.messengerIos).inAppBrowser, 'messenger');
  assert.equal(browserContext(UA.facebookAndroid).inAppBrowser, 'facebook');
  assert.equal(browserContext(UA.plainWebView).inAppBrowser, 'android-webview');
});

test('browser hand-off: Chrome intent on Android, Safari (flagged unreliable) on iOS', () => {
  const android = browserHandoff(browserContext(UA.messengerAndroid), 'https://furnishar.example/plan?product=armchair');
  assert.equal(android.label, 'Open in Chrome');
  assert.match(android.href, /^intent:\/\/furnishar\.example\/plan\?product=armchair#Intent;scheme=https;package=com\.android\.chrome;/);
  const ios = browserHandoff(browserContext(UA.messengerIos), 'https://furnishar.example/plan');
  assert.equal(ios.label, 'Open in Safari');
  assert.equal(ios.unreliable, true);
  assert.equal(browserHandoff(browserContext(UA.infinixChrome), 'https://x'), null);
});

test('the session request needs only hit-test; depth is never in it', () => {
  const init = sessionInit({ domOverlayRoot: {}, purpose: 'scan' });
  assert.deepEqual(init.requiredFeatures, ['hit-test']);
  assert.ok(!init.optionalFeatures.includes('depth-sensing'));
  assert.ok(!('depthSensing' in init));
  assert.ok(init.optionalFeatures.includes('local-floor'));
  assert.ok(init.optionalFeatures.includes('plane-detection'), 'planes help a scan');
  assert.ok(!sessionInit({ purpose: 'placement' }).optionalFeatures.includes('plane-detection'));
  assert.deepEqual(minimalSessionInit(), { requiredFeatures: ['hit-test'] });
});

const base = { secureContext: true, platform: 'android', webgl: true, webxr: true, cameraApi: true };

test('WebXR unavailable: no tracked claim, measurement alternatives offered', () => {
  const a = assessCapabilities({ ...base, webxr: false, immersiveArAdvertised: false, cameraOpened: true, orientationEvents: 40, orientationRate: 30, headingVerdict: 'bad' });
  assert.equal(a.trackedVerified, false);
  assert.equal(a.placement, EXPERIENCE.UNTRACKED_3D_PREVIEW);
  assert.ok(!a.measurementMethods.includes(MEASURE_METHOD.TRACKED_SCAN));
  assert.ok(a.measurementMethods.includes(MEASURE_METHOD.AIM_DISTANCE));
  assert.ok(!a.measurementMethods.includes(MEASURE_METHOD.AIM_ROOM), 'a bad compass builds no outline');
  assert.ok(a.measurementMethods.includes(MEASURE_METHOD.PHOTO));
  assert.ok(a.measurementMethods.includes(MEASURE_METHOD.MANUAL));
});

test('advertised but not verified: may be offered, never claimed', () => {
  const a = assessCapabilities({ ...base, immersiveArAdvertised: true });
  assert.equal(a.state, DIAG.AR_ADVERTISED_NOT_VERIFIED);
  assert.equal(a.trackedVerified, false);
  assert.equal(a.trackedWorthTrying, true);
});

test('advertised then refused (TECNO / vivo class): refused, not "your phone cannot"', () => {
  const refusal = classifyRefusal({ name: 'NotSupportedError', message: 'The specified session configuration is not supported.' });
  assert.equal(refusal.state, DIAG.AR_SESSION_REFUSED);
  assert.ok(refusal.likelyCauses.length > 1, 'several causes, none asserted');
  const a = assessCapabilities({ ...base, immersiveArAdvertised: true, sessionStarted: false, sessionError: refusal, cameraOpened: true });
  assert.equal(a.trackedWorthTrying, false);
  assert.equal(a.state, DIAG.AR_SESSION_REFUSED);
  assert.equal(a.placement, EXPERIENCE.UNTRACKED_3D_PREVIEW);
  assert.equal(a.recommendedExperience, EXPERIENCE.PHOTO_MEASUREMENT);
});

test('session starts but no hit-test source', () => {
  const a = assessCapabilities({ ...base, immersiveArAdvertised: true, sessionStarted: true, hitTestVerified: false, frames: 120 });
  assert.equal(a.trackedState, DIAG.HIT_TEST_UNAVAILABLE);
  assert.equal(a.trackedWorthTrying, false);
});

test('session + hit-test but zero hits: tracking available, no surface yet', () => {
  const a = assessCapabilities({ ...base, immersiveArAdvertised: true, sessionStarted: true, hitTestVerified: true, frames: 180, hitFrames: 0 });
  assert.equal(a.trackedState, DIAG.TRACKING_AVAILABLE_NO_SURFACE);
  assert.equal(a.trackedVerified, false);
  assert.equal(a.trackedWorthTrying, true);
});

test('session + hit-test + hits, with no planes and no depth (Infinix HOT 60i): verified tracked', () => {
  const a = assessCapabilities({
    ...base, immersiveArAdvertised: true, sessionStarted: true, hitTestVerified: true,
    frames: 340, hitFrames: 251, planeDetectionAvailable: false, depthAvailable: false
  });
  assert.equal(a.state, DIAG.SUPPORTED_TRACKED);
  assert.equal(a.trackedVerified, true);
  assert.equal(a.placement, EXPERIENCE.TRACKED_WEBXR);
  assert.equal(a.recommendedMeasurement, MEASURE_METHOD.TRACKED_SCAN);
});

test('in-app browser: open in your browser, before any AR attempt', () => {
  const ctx = browserContext(UA.messengerAndroid);
  const a = assessCapabilities({ ...base, ...ctx, immersiveArAdvertised: true });
  assert.equal(a.state, DIAG.IN_APP_BROWSER);
  assert.equal(a.placement, EXPERIENCE.UNSUPPORTED_CONTEXT);
  assert.equal(a.recommendedExperience, EXPERIENCE.UNSUPPORTED_CONTEXT);
  assert.equal(a.trackedWorthTrying, false);
});

test('iPhone: Quick Look for placement, no WebXR scanner, non-WebXR measurement', () => {
  const ctx = browserContext(UA.iphoneSafari);
  const a = assessCapabilities({ ...base, ...ctx, iosQuickLookEligible: true, cameraOpened: true, orientationEvents: 50, orientationRate: 60, headingVerdict: 'good' });
  assert.equal(a.placement, EXPERIENCE.NATIVE_IOS_QUICK_LOOK);
  assert.equal(a.trackedState, DIAG.IOS_WEBXR_NOT_APPLICABLE);
  assert.ok(!a.measurementMethods.includes(MEASURE_METHOD.TRACKED_SCAN));
  assert.ok(a.measurementMethods.includes(MEASURE_METHOD.AIM_ROOM));
  const noUsdz = assessCapabilities({ ...base, ...ctx, iosQuickLookEligible: false });
  assert.equal(noUsdz.placement, EXPERIENCE.UNTRACKED_3D_PREVIEW);
});

test('camera denied', () => {
  const a = assessCapabilities({ ...base, immersiveArAdvertised: true, cameraDenied: true });
  assert.equal(a.state, DIAG.CAMERA_PERMISSION_DENIED);
  assert.deepEqual(a.measurementMethods, [MEASURE_METHOD.MANUAL]);
  assert.equal(classifyRefusal({ name: 'NotAllowedError', message: '' }).state, DIAG.CAMERA_PERMISSION_DENIED);
});

test('insecure context and slow sensors', () => {
  assert.equal(assessCapabilities({ ...base, secureContext: false }).state, DIAG.INSECURE_CONTEXT);
  const slow = assessCapabilities({ ...base, webxr: false, cameraOpened: true, orientationEvents: 6, orientationRate: 2 });
  assert.ok(!slow.measurementMethods.includes(MEASURE_METHOD.AIM_DISTANCE), 'a 2 Hz sensor cannot follow a hand');
});

test('nothing usable: manual only', () => {
  const a = assessCapabilities({ ...base, webxr: false, cameraApi: false, cameraOpened: false, orientationEvents: 0 });
  assert.equal(a.state, DIAG.MANUAL_ONLY);
  assert.deepEqual(a.measurementMethods, [MEASURE_METHOD.MANUAL]);
});

test('the diagnostic report is an allowlist and carries no private identifiers', () => {
  const report = diagnosticReport({
    userAgent: UA.infinixChrome, frames: 340, hitFrames: 251, imei: '356938035643809',
    serialNumber: 'R58M123', macAddress: '00:11:22:33:44:55',
    sessionError: { name: 'NotSupportedError', message: 'x', imei: 'leak' }
  }, assessCapabilities({ ...base, immersiveArAdvertised: true }));
  const text = JSON.stringify(report);
  assert.ok(!/imei|serial|mac/i.test(text), text);
  assert.equal(report.frames, 340);
  assert.ok(report.state);
});
