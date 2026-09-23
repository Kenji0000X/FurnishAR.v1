const FLASH_KEY = 'furnishar-flash';

function readMemory() {
  if (!globalThis.__furnishar_flash__) {
    globalThis.__furnishar_flash__ = null;
  }
  return globalThis.__furnishar_flash__;
}

function statusType(value) {
  const next = String(value || 'info').toLowerCase();
  return next === 'success' || next === 'error' || next === 'warning' ? next : 'info';
}

function safeMessage(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed || '';
}

export function setFlash(message, type = 'info') {
  const safe = safeMessage(message);
  if (!safe) return null;
  const payload = { message: safe, type: statusType(type) };

  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      window.sessionStorage.setItem(FLASH_KEY, JSON.stringify(payload));
      window.dispatchEvent(new CustomEvent('furnishar-flash', { detail: payload }));
      return payload;
    }
  } catch {
    // Session storage may be unavailable in private mode.
  }

  globalThis.__furnishar_flash__ = payload;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('furnishar-flash', { detail: payload }));
  }
  return payload;
}

export function consumeFlash() {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      const raw = window.sessionStorage.getItem(FLASH_KEY);
      if (raw) {
        window.sessionStorage.removeItem(FLASH_KEY);
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.message === 'string') {
          return { message: parsed.message, type: statusType(parsed.type) };
        }
      }
    }
  } catch {
    // Ignore malformed or blocked storage values.
  }

  const stored = readMemory();
  if (stored) {
    globalThis.__furnishar_flash__ = null;
    return stored;
  }
  return null;
}

export function flashSuccess(message) {
  return setFlash(message, 'success');
}

export function flashError(message) {
  return setFlash(message, 'error');
}

export function flashInfo(message) {
  return setFlash(message, 'info');
}

export const FLASH_KEY_NAME = FLASH_KEY;
