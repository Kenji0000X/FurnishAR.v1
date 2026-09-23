const STORAGE_KEY = 'furnishar-auth-intent';

function getMemoryStore() {
  if (!globalThis.__furnishar_auth_intent__) {
    globalThis.__furnishar_auth_intent__ = {};
  }
  return globalThis.__furnishar_auth_intent__;
}

function getStorage() {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) return window.sessionStorage;
  } catch {
    // Some browsers block sessionStorage in private or restricted mode.
  }
  return null;
}

function normalizeAuthIntent(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('javascript:')) {
    return null;
  }
  if (!trimmed.startsWith('/')) return null;
  // A browser reads "\" as "/" and drops tabs and newlines, so "/\evil.example"
  // and "/<tab>/evil.example" are both "//evil.example" — another site.
  if (/[\\\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

function saveAuthIntent(value) {
  const safeValue = normalizeAuthIntent(value);
  if (!safeValue) return null;

  const storage = getStorage();
  if (storage) {
    storage.setItem(STORAGE_KEY, safeValue);
    return safeValue;
  }

  getMemoryStore()[STORAGE_KEY] = safeValue;
  return safeValue;
}

function consumeAuthIntent() {
  const storage = getStorage();
  if (storage) {
    const value = storage.getItem(STORAGE_KEY);
    storage.removeItem(STORAGE_KEY);
    return normalizeAuthIntent(value);
  }

  const store = getMemoryStore();
  const value = store[STORAGE_KEY];
  delete store[STORAGE_KEY];
  return normalizeAuthIntent(value);
}

function peekAuthIntent() {
  const storage = getStorage();
  if (storage) {
    return normalizeAuthIntent(storage.getItem(STORAGE_KEY));
  }

  const value = getMemoryStore()[STORAGE_KEY];
  return normalizeAuthIntent(value);
}

module.exports = {
  STORAGE_KEY,
  saveAuthIntent,
  consumeAuthIntent,
  peekAuthIntent,
};
