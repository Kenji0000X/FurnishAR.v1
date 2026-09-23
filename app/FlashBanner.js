'use client';

import { useEffect, useState } from 'react';
import { consumeFlash } from '../lib/flash.js';

export default function FlashBanner() {
  const [flash, setFlash] = useState(null);

  useEffect(() => {
    const read = () => {
      const next = consumeFlash();
      if (next) setFlash(next);
    };

    read();
    const handler = event => {
      const detail = event?.detail || consumeFlash();
      if (detail && typeof detail.message === 'string') {
        setFlash({ message: detail.message, type: detail.type || 'info' });
      }
    };

    window.addEventListener('furnishar-flash', handler);
    return () => window.removeEventListener('furnishar-flash', handler);
  }, []);

  useEffect(() => {
    if (!flash) return undefined;
    const timer = setTimeout(() => setFlash(null), 3400);
    return () => clearTimeout(timer);
  }, [flash]);

  if (!flash) return null;

  return (
    <div className={`status-banner status-banner-${flash.type || 'info'}`} role="status" aria-live="polite">
      <span className="loading-spinner" aria-hidden="true" />
      <span>{flash.message}</span>
    </div>
  );
}
