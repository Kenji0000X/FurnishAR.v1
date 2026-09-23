'use client';

import { useEffect } from 'react';
import { consumeFlash } from '../lib/flash.js';
import { notify } from '../lib/alerts/store.mjs';

/**
 * The bridge from lib/flash.js to the one alert system.
 *
 * lib/flash.js is the "say this after the page changes" API — flashSuccess(),
 * flashError(), flashInfo() — and it keeps the message in sessionStorage so it
 * survives a full page load. It used to draw its own banner as well, which
 * made two notification systems with two looks, two placements and two sets of
 * screen-reader behaviour; the same event could be announced twice.
 *
 * Now it draws nothing. A flash left by the previous page, or raised on this
 * one, is handed to the alert store and shown by AlertContainer like every
 * other alert: same icons, same live regions, same dismiss, same dedup.
 *
 * A flash raised on THIS page is also taken out of storage as it is shown.
 * Before, the event path displayed it but left it stored, so it appeared a
 * second time on the next page load.
 */
export default function FlashBanner() {
  useEffect(() => {
    const deliver = flash => {
      if (flash?.message) notify({ type: flash.type || 'info', message: flash.message });
    };
    deliver(consumeFlash());
    const onFlash = () => deliver(consumeFlash());
    window.addEventListener('furnishar-flash', onFlash);
    return () => window.removeEventListener('furnishar-flash', onFlash);
  }, []);

  return null;
}
