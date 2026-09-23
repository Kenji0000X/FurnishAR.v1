/**
 * Every notification FurnishAR can raise, written once.
 *
 * Each entry says what happened, and — where there is something to do —
 * what to do next. None of them says "Something went wrong." with nothing
 * after it: that sentence tells a person their afternoon is over and gives
 * them nothing to do about it.
 *
 * Nothing technical crosses into these strings. A status code, a table name,
 * a storage path or a stack trace belongs in the server log, where the person
 * who can fix it will look; the person in front of the screen needs to know
 * whether to try again, sign in, or give up.
 *
 * `priority` follows the store's scale: critical alerts stay until dismissed,
 * so only the ones a person must not miss are marked critical.
 */

export const CATALOG = Object.freeze({
  /* ------------------------------------------------------------ accounts */
  'auth.signed-in': { type: 'success', title: 'Signed in', message: 'Welcome back.' },
  'auth.signed-up': {
    type: 'success', title: 'Account created',
    message: 'Account created successfully.'
  },
  'auth.signed-out': { type: 'success', title: 'Signed out', message: "You've been signed out." },
  'auth.sign-out-failed': {
    type: 'error', title: 'Sign-out incomplete',
    message: "We couldn't complete sign-out on the server. You are signed out on this device; close the tab to be sure."
  },
  'auth.required': {
    type: 'info', priority: 'high', title: 'Sign in to continue',
    message: 'Please sign in to view this furniture in 3D.'
  },
  'auth.expired': {
    type: 'warning', priority: 'critical', title: 'Session expired',
    message: 'Your session has expired. Please sign in again.'
  },
  'auth.rate-limited': {
    type: 'warning', priority: 'high', title: 'Too many attempts',
    message: 'Too many sign-in attempts. Please wait a moment and try again.'
  },

  /* ------------------------------------------------------------ profile */
  'profile.saved': { type: 'success', title: 'Saved', message: 'Profile updated successfully.' },
  'profile.save-failed': {
    type: 'error', title: 'Not saved',
    message: "We couldn't save your details. Please try again."
  },

  /* ------------------------------------------------------------ 3D / AR */
  'model.forbidden': {
    type: 'error', priority: 'critical', title: '3D preview unavailable',
    message: "You don't have permission to view this 3D model."
  },
  'model.not-found': {
    type: 'error', title: 'Model not found',
    message: 'This piece no longer has a 3D model. The store may have removed it.'
  },
  'model.load-failed': {
    type: 'error', title: '3D model failed',
    message: "We couldn't load the 3D model. Please try again."
  },
  'ar.unavailable': {
    type: 'info', title: 'AR unavailable',
    message: 'AR is currently unavailable on this device. Guided measurement still works.'
  },
  'ar.tracking-lost': {
    type: 'warning', title: 'Tracking lost',
    message: 'Tracking lost. Move your phone slowly.'
  },
  'camera.denied': {
    type: 'warning', priority: 'high', title: 'Camera blocked',
    message: 'Camera access is required for room scanning. Allow it in your browser settings, then try again.'
  },
  'camera.unavailable': {
    type: 'error', title: 'No camera',
    message: "We couldn't access your camera. Check your device permissions."
  },

  /* ------------------------------------------------------------ network */
  'net.offline': {
    type: 'error', priority: 'high', title: 'No connection',
    message: 'Connection failed. Check your internet connection and try again.'
  },
  'net.timeout': {
    type: 'error', priority: 'high', title: 'Took too long',
    message: 'The server took too long to answer. Please try again.'
  }
});

/**
 * An HTTP status, in words.
 *
 * `context` lets a caller name the thing that was not found or not allowed —
 * "furniture", "3D model" — so a 404 reads as the actual missing object
 * rather than a generic "resource".
 */
export function describeStatus(status, context = 'request') {
  switch (Number(status)) {
    case 400:
      return { type: 'error', title: 'Could not process that', message: 'Please check the information you entered and try again.' };
    case 401:
      return { ...CATALOG['auth.expired'] };
    case 403:
      return { type: 'error', priority: 'critical', title: 'Not allowed', message: `You don't have permission to perform this ${context}.` };
    case 404:
      return { type: 'error', title: 'Not found', message: `The requested ${context} could not be found.` };
    case 409:
      return { type: 'error', title: 'Already exists', message: 'This information already exists.' };
    case 422:
      return { type: 'error', title: 'Check your details', message: 'Please check the information you entered.' };
    case 429:
      return { type: 'warning', priority: 'high', title: 'Slow down', message: 'Too many requests. Please wait a moment and try again.' };
    case 500:
      return { type: 'error', priority: 'high', title: 'Server problem', message: 'Something went wrong on the server. Please try again.' };
    case 502:
    case 503:
    case 504:
      return { type: 'error', priority: 'high', title: 'Service unavailable', message: 'The service is temporarily unavailable. Please try again in a moment.' };
    default:
      return { type: 'error', title: 'Request failed', message: 'That did not work. Please try again.' };
  }
}

/**
 * Any thrown error, in words.
 *
 * fetch() rejects with a TypeError when the network is gone and an
 * AbortError when a timeout fires — neither has a status, and both used to
 * surface as the raw browser string ("Failed to fetch"), which describes the
 * API rather than the problem.
 */
export function describeError(error, context) {
  if (!error) return describeStatus(0, context);
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return { ...CATALOG['net.timeout'] };
  if (error instanceof TypeError || /failed to fetch|network|load failed/i.test(error.message || '')) {
    return { ...CATALOG['net.offline'] };
  }
  if (error.status) return describeStatus(error.status, context);
  return describeStatus(0, context);
}

/** A catalog entry by key, with any overrides — the usual way to raise one. */
export function catalog(key, overrides = {}) {
  const entry = CATALOG[key];
  if (!entry) throw new Error(`Unknown alert: ${key}`);
  return { ...entry, key, ...overrides };
}
