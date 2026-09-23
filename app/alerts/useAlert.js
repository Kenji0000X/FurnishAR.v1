'use client';

import {
  notify, update, dismiss, showSuccess, showError, showWarning, showInfo
} from '../../lib/alerts/store.mjs';
import { catalog, describeError, describeStatus } from '../../lib/alerts/messages.mjs';

/**
 * The notification system, from any React component.
 *
 *   const alert = useAlert();
 *   alert.showSuccess('Room saved successfully.');
 *   alert.raise('auth.expired', { actions: [{ label: 'Sign in', href }] });
 *   alert.fromError(error, '3D model');
 *
 * A hook rather than a bare import only so components read naturally; it
 * holds no state. The store is module-level so the vanilla AR engine can
 * raise alerts through the same queue — see lib/alerts/store.mjs.
 */
const api = Object.freeze({
  notify,
  update,
  dismiss,
  showSuccess,
  showError,
  showWarning,
  showInfo,
  /** Raise a catalog entry by key. */
  raise: (key, overrides) => notify(catalog(key, overrides)),
  /** Raise the human reading of a thrown error or failed request. */
  fromError: (error, context, overrides) => notify({ ...describeError(error, context), ...overrides }),
  fromStatus: (status, context, overrides) => notify({ ...describeStatus(status, context), ...overrides })
});

export default function useAlert() {
  return api;
}

export { api as alerts };
