/**
 * What can this device actually do, and which FurnishAR experience does that
 * earn it?
 *
 * One module decides. Before it, "can this phone do AR?" was a single boolean
 * (navigator.xr.isSessionSupported('immersive-ar')) asked in two places and
 * answered differently in each, and every failure below it fell into one
 * "camera preview" bucket that was then presented as if it were AR.
 *
 * The rules this encodes, each one learned from a real phone:
 *
 *   CAMERA ACCESS != TRACKED AR.     A phone that opens its camera (TECNO
 *                                    KI5k, vivo 1906) may still never start
 *                                    an immersive-ar session.
 *   WEBGL != WEBXR.                  Drawing 3D is not tracking the world.
 *   ADVERTISED != VERIFIED.          isSessionSupported() = true is a promise;
 *                                    a session that opened AND returned hits is
 *                                    the fact. Only the fact earns "tracked".
 *   ENHANCEMENTS ARE OPTIONAL.       Plane detection and depth are never
 *                                    required. The Infinix HOT 60i tracks and
 *                                    places without either.
 *   iPHONE IS ITS OWN PATH.          Placement is Quick Look with a USDZ;
 *                                    room measurement is the non-WebXR methods.
 *   AN EMBEDDED BROWSER IS NOT CHROME.  Messenger's webview is not a verdict on
 *                                    the hardware; the answer is "open this in
 *                                    your browser", before any AR is attempted.
 *
 * Nothing here reads RAM, megapixels, chipset names or Android versions.
 * Runtime observations decide. The module is pure: callers gather facts
 * (see gatherBasicFacts in the browser) and pass them in, so every rule is
 * testable without a phone (tests/capabilities.test.js).
 */

/* --------------------------------------------------------------- tiers -- */

export const EXPERIENCE = Object.freeze({
  TRACKED_WEBXR: 'tracked-webxr',
  NATIVE_IOS_QUICK_LOOK: 'native-ios-quick-look',
  UNTRACKED_3D_PREVIEW: 'untracked-3d-preview',
  SENSOR_MEASUREMENT: 'sensor-measurement',
  PHOTO_MEASUREMENT: 'photo-measurement',
  MANUAL_MEASUREMENT: 'manual-measurement',
  UNSUPPORTED_CONTEXT: 'unsupported-context'
});

/** Room measurement methods, best first. Manual is always present. */
export const MEASURE_METHOD = Object.freeze({
  TRACKED_SCAN: 'tracked-scan',     // WebXR hit-test corners
  AIM_ROOM: 'aim-room',             // tilt + reliable heading: a room outline
  AIM_DISTANCE: 'aim-distance',     // tilt only: single distances, no outline
  PHOTO: 'photo',                   // reference rectangle, one plane per photo
  MANUAL: 'manual'                  // tape measure
});

/* ------------------------------------------------------ diagnostic states -- */

export const DIAG = Object.freeze({
  SUPPORTED_TRACKED: 'supported-tracked',
  AR_ADVERTISED_NOT_VERIFIED: 'ar-advertised-not-verified',
  AR_SESSION_REFUSED: 'ar-session-refused',
  HIT_TEST_UNAVAILABLE: 'hit-test-unavailable',
  TRACKING_AVAILABLE_NO_SURFACE: 'tracking-available-no-surface',
  AR_RUNTIME_PROBLEM: 'ar-runtime-problem',
  CAMERA_PERMISSION_DENIED: 'camera-permission-denied',
  UNSUPPORTED_BROWSER: 'unsupported-browser',
  IN_APP_BROWSER: 'in-app-browser',
  INSECURE_CONTEXT: 'insecure-context',
  IOS_WEBXR_NOT_APPLICABLE: 'ios-webxr-not-applicable',
  CAMERA_ONLY: 'camera-only',
  SENSOR_ONLY: 'sensor-only',
  MANUAL_ONLY: 'manual-only'
});

/* ------------------------------------------------------- browser context -- */

/**
 * Embedded browsers, by the markers they put in the user agent. Only the ones
 * that are common in the Philippines and known not to expose WebXR the way
 * the host browser does. Order matters: Messenger's UA also carries FBAN.
 */
const IN_APP = [
  { id: 'messenger', name: 'Messenger', test: /\bMessenger|FB_IAB\/MESSENGER|FBAN\/MessengerForiOS|\bOrca-Android\b/i },
  { id: 'facebook', name: 'Facebook', test: /\bFBAN\/|\bFBAV\/|\bFB_IAB\b|\bFBIOS\b/ },
  { id: 'instagram', name: 'Instagram', test: /\bInstagram\b/ },
  { id: 'tiktok', name: 'TikTok', test: /\bmusical_ly\b|\bBytedanceWebview\b|\bTikTok\b/i },
  { id: 'line', name: 'LINE', test: /\bLine\/\d/ },
  { id: 'viber', name: 'Viber', test: /\bViber\b/i },
  { id: 'snapchat', name: 'Snapchat', test: /\bSnapchat\b/ },
  { id: 'twitter', name: 'X', test: /\bTwitter(?:Android)?\b/ },
  { id: 'wechat', name: 'WeChat', test: /\bMicroMessenger\b/ },
  { id: 'gsa', name: 'the Google app', test: /\bGSA\/\d/ }
];

/**
 * Reads what a user agent can honestly say about the browser around the page.
 * The platform and browser family are for choosing a PATH (Quick Look vs
 * WebXR, which browser to hand off to), never for granting a capability.
 */
export function browserContext(userAgent = '', { maxTouchPoints = 0, platform = '' } = {}) {
  const ua = String(userAgent);
  const ios = /\b(iPhone|iPad|iPod)\b/.test(ua) || (platform === 'MacIntel' && maxTouchPoints > 1);
  const android = !ios && /\bAndroid\b/.test(ua);

  const inApp = IN_APP.find(entry => entry.test.test(ua)) || null;
  // A bare Android System WebView ("; wv)") inside some other app.
  const androidWebView = android && !inApp && /;\s*wv\)/.test(ua);

  let browserFamily = 'other';
  if (ios) {
    browserFamily = /\bCriOS\//.test(ua) ? 'chrome-ios'
      : /\bFxiOS\//.test(ua) ? 'firefox-ios'
      : /\bEdgiOS\//.test(ua) ? 'edge-ios'
      : /Version\/[\d.]+.*Safari\//.test(ua) ? 'safari' : 'ios-webview';
  } else if (/\bSamsungBrowser\//.test(ua)) browserFamily = 'samsung';
  else if (/\bOPR\/|\bOPiOS\b|\bOpera\b/.test(ua)) browserFamily = 'opera';
  else if (/\bEdgA?\//.test(ua)) browserFamily = 'edge';
  else if (/\bFirefox\//.test(ua)) browserFamily = 'firefox';
  else if (/\bChrome\/\d/.test(ua)) browserFamily = 'chrome';
  else if (/\bSafari\//.test(ua)) browserFamily = 'safari';

  /* The phone's own model string, when Android volunteers one. Reduced user
     agents replace it with "K"; that is reported as unknown, not guessed. */
  let deviceModel = null;
  const match = ua.match(/Android [\d.]+; ([^;)]+?)(?: Build\/[^;)]+)?\)/);
  if (match && match[1] && match[1] !== 'K' && !/^wv$/.test(match[1])) deviceModel = match[1].trim();

  return {
    platform: ios ? 'ios' : android ? 'android' : 'other',
    browserFamily,
    inAppBrowser: inApp ? inApp.id : androidWebView ? 'android-webview' : null,
    inAppName: inApp ? inApp.name : androidWebView ? 'an app’s built-in browser' : null,
    deviceModel
  };
}

/**
 * How to leave an embedded browser for a real one. Returns null where no
 * reliable hand-off exists, in which case the interface shows the copy-link
 * instructions instead of a button that might do nothing.
 */
export function browserHandoff(context, href) {
  if (!context?.inAppBrowser || !href) return null;
  let url;
  try { url = new URL(href); } catch { return null; }
  if (context.platform === 'android') {
    // Chrome's intent scheme. If Chrome is missing, Android offers a chooser.
    const path = `${url.host}${url.pathname}${url.search}`;
    return {
      label: 'Open in Chrome',
      href: `intent://${path}#Intent;scheme=${url.protocol.replace(':', '')};package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(href)};end`
    };
  }
  if (context.platform === 'ios') {
    /* There is no dependable way for a page to open Safari from a webview.
       x-safari-https works on recent iOS inside some apps and silently does
       nothing in others, so it is offered alongside the menu instructions,
       never alone. */
    return { label: 'Open in Safari', href: `x-safari-${url.href}`, unreliable: true };
  }
  return null;
}

/* -------------------------------------------------------- session config -- */

/**
 * The ONE session request FurnishAR makes from a tap: the minimum it needs.
 *
 * Hit-test is required: placement and corner capture are built on it and
 * nothing else. local-floor, dom-overlay and plane-detection are asked for
 * optionally, because a browser that does not have them still opens the
 * session. depth-sensing is NOT in this request. Asking for it with its init
 * dictionary is exactly what made capable phones refuse the whole session
 * ("The specified session configuration is not supported"); occlusion is an
 * enhancement and never worth losing tracking for.
 *
 * If this is refused, a different configuration is only tried from a NEW tap:
 * a second requestSession in the same handler runs without the user
 * activation the first one consumed, and its failure says nothing about the
 * device.
 */
export function sessionInit({ domOverlayRoot = null, purpose = 'placement' } = {}) {
  const optionalFeatures = ['local-floor'];
  if (domOverlayRoot) optionalFeatures.push('dom-overlay');
  // Planes help a room scan find walls; they never gate anything.
  if (purpose === 'scan') optionalFeatures.push('plane-detection');
  const init = { requiredFeatures: ['hit-test'], optionalFeatures };
  if (domOverlayRoot) init.domOverlay = { root: domOverlayRoot };
  return init;
}

/**
 * The retry, offered only after a refusal and only from a new tap: the same
 * required hit-test with nothing optional, which rules out an optional
 * feature (usually dom-overlay) as the cause.
 */
export function minimalSessionInit() {
  return { requiredFeatures: ['hit-test'] };
}

/* ------------------------------------------------------- classification -- */

/**
 * A refusal, classified by what the browser actually said.
 *
 * Deliberately modest. A NotSupportedError from a browser that ADVERTISED
 * immersive-ar has several possible causes (runtime missing or out of date,
 * a feature in the request, a device profile, the browser) and the report
 * says that rather than naming one of them as fact.
 */
export function classifyRefusal(error, facts = {}) {
  const name = error?.name || 'Error';
  const message = String(error?.message || '');
  if (name === 'NotAllowedError' || /permission|denied/i.test(message)) {
    return { state: DIAG.CAMERA_PERMISSION_DENIED, name, message };
  }
  if (name === 'SecurityError') {
    return {
      state: facts.inAppBrowser ? DIAG.IN_APP_BROWSER : DIAG.AR_SESSION_REFUSED, name, message,
      likelyCauses: ['the page is embedded or not in a secure top-level context', 'the tap was not counted as a user gesture']
    };
  }
  if (/install|arcore|play services|runtime/i.test(message)) {
    return { state: DIAG.AR_RUNTIME_PROBLEM, name, message, likelyCauses: ['Google Play Services for AR is missing or needs an update'] };
  }
  return {
    state: DIAG.AR_SESSION_REFUSED, name, message,
    likelyCauses: [
      'Google Play Services for AR is missing, out of date, or was declined',
      'this browser or device profile does not support the requested session',
      'an optional feature in the request was rejected'
    ]
  };
}

/**
 * The whole picture: facts in, one decision out.
 *
 * `facts` is whatever has been observed so far. Missing facts are unknowns,
 * never defaults in either direction. The fields match what /diagnose reports
 * and what the copyable report contains.
 *
 *   secureContext, platform, browserFamily, inAppBrowser
 *   webgl, cameraApi, cameraOpened (true/false/undefined), cameraDenied
 *   immersiveArAdvertised       isSessionSupported('immersive-ar')
 *   sessionStarted              a session opened from a tap
 *   sessionError                what the refusal said, classified
 *   hitTestVerified             a hit-test source was created
 *   hitFrames, frames           frames that returned at least one hit
 *   localFloorAvailable, planeDetectionAvailable, depthAvailable
 *   orientationEvents, orientationRate, absoluteHeadingAvailable,
 *   headingVerdict ('good' | 'noisy' | 'bad' | 'unknown'), motionEvents
 *   iosQuickLookEligible        the product has a USDZ the account may open
 */
export function assessCapabilities(facts = {}) {
  const f = { ...facts };
  const reasons = [];

  const embedded = Boolean(f.inAppBrowser);
  const ios = f.platform === 'ios';
  const insecure = f.secureContext === false;

  /* --- tracked AR ----------------------------------------------------- */
  let trackedState;
  if (insecure) trackedState = DIAG.INSECURE_CONTEXT;
  else if (embedded) trackedState = DIAG.IN_APP_BROWSER;
  else if (ios) trackedState = DIAG.IOS_WEBXR_NOT_APPLICABLE;
  else if (f.cameraDenied || f.sessionError?.state === DIAG.CAMERA_PERMISSION_DENIED) trackedState = DIAG.CAMERA_PERMISSION_DENIED;
  else if (f.sessionStarted === true && f.hitTestVerified === false) trackedState = DIAG.HIT_TEST_UNAVAILABLE;
  else if (f.sessionStarted === true && f.hitTestVerified && (f.frames || 0) > 0 && (f.hitFrames || 0) === 0) trackedState = DIAG.TRACKING_AVAILABLE_NO_SURFACE;
  else if (f.sessionStarted === true && f.hitTestVerified && (f.hitFrames || 0) > 0) trackedState = DIAG.SUPPORTED_TRACKED;
  else if (f.sessionError) trackedState = f.sessionError.state || DIAG.AR_SESSION_REFUSED;
  else if (f.immersiveArAdvertised === true) trackedState = DIAG.AR_ADVERTISED_NOT_VERIFIED;
  else if (f.immersiveArAdvertised === false || f.webxr === false) trackedState = DIAG.UNSUPPORTED_BROWSER;
  else trackedState = DIAG.AR_ADVERTISED_NOT_VERIFIED;

  const trackedVerified = trackedState === DIAG.SUPPORTED_TRACKED;
  /* "Worth trying" is weaker than verified: advertised, or a session that
     opened and simply has not seen a surface yet. The planner may OFFER
     tracked AR on these; it may not CLAIM it until hits arrive. */
  const trackedWorthTrying = trackedVerified
    || trackedState === DIAG.AR_ADVERTISED_NOT_VERIFIED
    || trackedState === DIAG.TRACKING_AVAILABLE_NO_SURFACE;

  /* --- non-tracked measurement ----------------------------------------- */
  const cameraUsable = f.cameraOpened === true || (f.cameraOpened === undefined && f.cameraApi === true && !f.cameraDenied);
  const tiltUsable = (f.orientationEvents || 0) > 0 && (f.orientationRate == null || f.orientationRate >= 8);
  const headingUsable = tiltUsable && f.headingVerdict === 'good';

  const measurementMethods = [];
  if (trackedWorthTrying) measurementMethods.push(MEASURE_METHOD.TRACKED_SCAN);
  if (cameraUsable && headingUsable) measurementMethods.push(MEASURE_METHOD.AIM_ROOM);
  if (cameraUsable && tiltUsable) measurementMethods.push(MEASURE_METHOD.AIM_DISTANCE);
  if (cameraUsable) measurementMethods.push(MEASURE_METHOD.PHOTO);
  measurementMethods.push(MEASURE_METHOD.MANUAL);

  if (tiltUsable && !headingUsable && f.headingVerdict && f.headingVerdict !== 'unknown') {
    reasons.push('The compass is unreliable here, so a room outline cannot be built by turning. Single distances still work.');
  }

  /* --- placement -------------------------------------------------------- */
  let placement;
  if (embedded || insecure) placement = EXPERIENCE.UNSUPPORTED_CONTEXT;
  else if (ios) placement = f.iosQuickLookEligible ? EXPERIENCE.NATIVE_IOS_QUICK_LOOK : EXPERIENCE.UNTRACKED_3D_PREVIEW;
  else if (trackedWorthTrying) placement = EXPERIENCE.TRACKED_WEBXR;
  else placement = f.webgl === false ? EXPERIENCE.MANUAL_MEASUREMENT : EXPERIENCE.UNTRACKED_3D_PREVIEW;

  /* --- one headline state for the device check ------------------------- */
  let state = trackedState;
  if (!trackedWorthTrying && ![DIAG.IN_APP_BROWSER, DIAG.INSECURE_CONTEXT, DIAG.CAMERA_PERMISSION_DENIED].includes(trackedState)) {
    // Say what IS possible, when tracked AR is not.
    if (ios) state = DIAG.IOS_WEBXR_NOT_APPLICABLE;
    else if (cameraUsable && tiltUsable) state = trackedState === DIAG.UNSUPPORTED_BROWSER ? DIAG.UNSUPPORTED_BROWSER : trackedState;
    else if (cameraUsable) state = trackedState === DIAG.UNSUPPORTED_BROWSER || trackedState === DIAG.AR_SESSION_REFUSED ? trackedState : DIAG.CAMERA_ONLY;
    else if (tiltUsable) state = DIAG.SENSOR_ONLY;
    else state = DIAG.MANUAL_ONLY;
  }

  const recommendedExperience = embedded || insecure
    ? EXPERIENCE.UNSUPPORTED_CONTEXT
    : trackedVerified || trackedWorthTrying ? EXPERIENCE.TRACKED_WEBXR
      : measurementMethods.includes(MEASURE_METHOD.AIM_DISTANCE) ? EXPERIENCE.SENSOR_MEASUREMENT
        : measurementMethods.includes(MEASURE_METHOD.PHOTO) ? EXPERIENCE.PHOTO_MEASUREMENT
          : EXPERIENCE.MANUAL_MEASUREMENT;

  return {
    state,
    trackedState,
    trackedVerified,
    trackedWorthTrying,
    placement,
    measurementMethods,
    recommendedMeasurement: measurementMethods[0],
    recommendedExperience,
    reasons
  };
}

/* ----------------------------------------------------------------- copy -- */

/** Plain-language summary for each state: what was observed, what it likely
    means, what to do. Kept separate so no sentence claims more than its state. */
export const DIAG_COPY = {
  [DIAG.SUPPORTED_TRACKED]: {
    title: 'Tracked AR works on this phone',
    observed: 'An AR session opened and found real surfaces.',
    action: null
  },
  [DIAG.AR_ADVERTISED_NOT_VERIFIED]: {
    title: 'Tracked AR not checked yet',
    observed: 'The browser says it supports AR. That is not confirmed until a session opens and finds a surface.',
    action: 'Run the AR check.'
  },
  [DIAG.AR_SESSION_REFUSED]: {
    title: 'The AR session did not start',
    observed: 'The browser refused to start an AR session.',
    likely: 'Possible causes: Google Play Services for AR is missing or out of date, this browser does not support it on this phone, or a requested feature was rejected. Which one is not known from this alone.',
    action: 'Update Google Play Services for AR from the Play Store, use Chrome, and try again. Photo and tape-measure methods still work.'
  },
  [DIAG.HIT_TEST_UNAVAILABLE]: {
    title: 'AR starts, but cannot find surfaces',
    observed: 'A session opened but did not provide hit-testing, which placing and measuring need.',
    action: 'Use the photo or tape-measure methods on this phone.'
  },
  [DIAG.TRACKING_AVAILABLE_NO_SURFACE]: {
    title: 'AR works, no surface found yet',
    observed: 'The session ran and hit-testing is available, but no surface was found during the check.',
    likely: 'Usually the room: low light, a plain or shiny floor, or the phone moving too fast.',
    action: 'Try again in better light, pointing at a floor with some pattern, moving slowly.'
  },
  [DIAG.AR_RUNTIME_PROBLEM]: {
    title: 'The AR service needs attention',
    observed: 'The browser reported a problem with the AR service.',
    action: 'Install or update Google Play Services for AR from the Play Store, then try again.'
  },
  [DIAG.CAMERA_PERMISSION_DENIED]: {
    title: 'Camera access is blocked',
    observed: 'The camera permission was refused for this site.',
    action: 'Allow the camera for this site in the browser’s site settings, then try again.'
  },
  [DIAG.UNSUPPORTED_BROWSER]: {
    title: 'Tracked AR is not available in this browser',
    observed: 'This browser does not offer WebXR AR.',
    action: 'On Android, open FurnishAR in Chrome. Photo and tape-measure methods work here.'
  },
  [DIAG.IN_APP_BROWSER]: {
    title: 'Open FurnishAR in your browser for camera tracking',
    observed: 'This page is open inside another app’s built-in browser, which does not provide the same camera and AR features.',
    likely: 'This says nothing about your phone. The app’s browser is the limit.',
    action: 'Open this page in Chrome (Android) or Safari (iPhone).'
  },
  [DIAG.INSECURE_CONTEXT]: {
    title: 'This page is not secure',
    observed: 'The page is not served over HTTPS, so the browser will not allow the camera or AR.',
    action: 'Open the https:// address.'
  },
  [DIAG.IOS_WEBXR_NOT_APPLICABLE]: {
    title: 'iPhone uses Apple AR Quick Look',
    observed: 'Safari on iPhone does not run WebXR AR, so FurnishAR’s room scanner does not run here.',
    action: 'Furniture is placed with AR Quick Look. Measure the room by photo or tape measure.'
  },
  [DIAG.CAMERA_ONLY]: {
    title: 'Camera works, tracked AR does not',
    observed: 'The camera opens, but no tracked AR session is available.',
    action: 'Measure with the photo method or a tape measure.'
  },
  [DIAG.SENSOR_ONLY]: {
    title: 'Motion sensors work, the camera does not',
    observed: 'The tilt sensor reports angles, but the camera did not open.',
    action: 'Measure with a tape measure.'
  },
  [DIAG.MANUAL_ONLY]: {
    title: 'Measure with a tape measure',
    observed: 'Neither tracked AR, the camera nor the motion sensors are usable here.',
    action: 'Type in tape-measure figures. That is the most accurate method anyway.'
  }
};

export const METHOD_LABEL = {
  [MEASURE_METHOD.TRACKED_SCAN]: 'Tracked room scan',
  [MEASURE_METHOD.AIM_ROOM]: 'Aim with phone',
  [MEASURE_METHOD.AIM_DISTANCE]: 'Aim with phone (single distances)',
  [MEASURE_METHOD.PHOTO]: 'Photo reference',
  [MEASURE_METHOD.MANUAL]: 'Tape measure'
};

/* -------------------------------------------------------------- report -- */

/**
 * The copyable technical report. An allowlist: only these keys, so nothing
 * private can ride along by accident. No IMEI, serial, ICCID, MEID or MAC
 * address exists in a browser's reach anyway; this makes sure no future
 * field smuggles in an identifier either.
 */
const REPORT_KEYS = [
  'generatedAt', 'userAgent', 'platform', 'browserFamily', 'inAppBrowser', 'deviceModel',
  'viewport', 'devicePixelRatio', 'secureContext', 'webgl', 'webxr',
  'immersiveArAdvertised', 'sessionStarted', 'sessionFeatures', 'sessionError',
  'hitTestVerified', 'frames', 'hitFrames', 'planesObserved', 'depthObserved', 'localFloorAvailable',
  'cameraApi', 'cameraOpened', 'cameraResolution', 'cameraDenied',
  'orientationEvents', 'orientationRate', 'absoluteHeadingAvailable', 'headingVerdict', 'motionEvents',
  'trackingQuality', 'measurementMethod', 'state', 'recommendedExperience', 'measurementMethods'
];

const FORBIDDEN = /imei|serial|iccid|meid|mac.?address|bluetooth|advertising.?id/i;

export function diagnosticReport(facts = {}, assessment = null) {
  const merged = { ...facts, ...(assessment ? {
    state: assessment.state,
    recommendedExperience: assessment.recommendedExperience,
    measurementMethods: assessment.measurementMethods
  } : {}) };
  const report = {};
  for (const key of REPORT_KEYS) {
    if (merged[key] === undefined || FORBIDDEN.test(key)) continue;
    const value = merged[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      report[key] = Object.fromEntries(Object.entries(value).filter(([k]) => !FORBIDDEN.test(k)));
    } else {
      report[key] = value;
    }
  }
  return report;
}
