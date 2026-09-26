/**
 * Peso ↔ centavo conversion — the ONE place it happens.
 *
 * FurnishAR's database keeps money as numeric(12,2) pesos. PayMongo's API
 * takes and returns amounts in centavos, the smallest PHP unit (₱499.00 is
 * 49900 in PayMongo's own Checkout example). Every conversion goes through
 * these two functions; nothing else multiplies or divides by 100.
 *
 * No floating-point arithmetic decides an amount: a value is first written
 * as a two-decimal string, then its digits are read as an integer.
 */

/** ₱ (number or numeric string, at most 2 decimals) → integer centavos. */
function phpToCentavos(value) {
  const text = typeof value === 'number' ? value.toFixed(2) : String(value ?? '').trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new TypeError(`Not a peso amount: ${String(value).slice(0, 20)}`);
  const [, sign, whole, fraction = ''] = match;
  const centavos = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(centavos)) throw new RangeError('Amount out of range.');
  return sign ? -centavos : centavos;
}

/** Integer centavos → ₱ as a two-decimal string ("11000.00"), exact. */
function centavosToPhp(centavos) {
  const n = Number(centavos);
  if (!Number.isSafeInteger(n)) throw new TypeError(`Not a centavo amount: ${String(centavos).slice(0, 20)}`);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

module.exports = { phpToCentavos, centavosToPhp };
