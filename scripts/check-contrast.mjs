/**
 * Measures every documented colour pair against WCAG AA, in BOTH themes.
 *
 * BRAND.md says its contrast table is "computed from the live token values",
 * not estimated — so there has to be something that actually computes it.
 * Adding a dark theme doubled the number of pairs that can silently drift, and
 * a token nudged for looks is exactly the change that breaks a ratio without
 * anyone noticing until an examiner runs an audit.
 *
 * The values are parsed out of the stylesheet rather than duplicated here. A
 * copy of the palette in this file would be one more thing to forget to
 * update, and it would happily report PASS on colours the site no longer uses.
 *
 *   node scripts/check-contrast.mjs
 */
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

/** Pulls the `--name: #value;` declarations out of one CSS block. */
function tokensIn(blockSelector) {
  const start = css.indexOf(blockSelector);
  if (start === -1) throw new Error(`no ${blockSelector} block in styles.css`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const block = css.slice(open, close);
  const found = {};
  for (const [, name, value] of block.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    found[name] = value;
  }
  return found;
}

const hexToRgb = h => {
  const clean = h.replace('#', '');
  const full = clean.length === 3 ? [...clean].map(c => c + c).join('') : clean;
  return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16) / 255);
};
const linearise = c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = h => {
  const [r, g, b] = hexToRgb(h).map(linearise);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// fg, bg, minimum. 3 is the large-text/non-text threshold; 4.5 is body text.
const PAIRS = [
  ['--ink', '--paper', 4.5, 'body text'],
  ['--ink-muted', '--paper', 4.5, 'secondary text'],
  ['--ink-faint', '--paper', 4.5, 'micro-labels'],
  ['--ink-faint', '--paper-raised', 4.5, 'micro-labels on cards'],
  ['--ink-faint', '--paper-sunken', 4.5, 'micro-labels on recesses'],
  ['--accent-ink', '--paper', 4.5, 'small accent text'],
  ['--accent', '--paper', 3, 'display accent (large only)'],
  ['--on-accent', '--accent', 4.5, 'text on the accent fill'],
  ['--danger', '--paper-raised', 4.5, 'form errors'],

  // The deep tone stopped being a one-off block the moment the home page got
  // two full-bleed bands on it. Everything that sits on --deep is measured
  // here, and adding these caught a real failure: the primary button on a band
  // filled with --accent-lifted and wrote --ink on it, which is 6.5:1 in the
  // light theme and 2.1:1 in the dark one — the same rule, passing in the
  // theme it was designed in and failing in the other.
  ['--on-deep', '--deep', 4.5, 'text on the deep panels'],
  ['--on-deep', '--band', 4.5, 'text on the home-page bands'],
  ['--on-deep-muted', '--band', 4.5, 'secondary text on the home-page bands'],
  ['--accent-lifted', '--band', 4.5, 'eyebrows and step links on the bands'],
  ['--paper', '--ink', 4.5, 'footer text'],
  ['--on-ink-accent', '--ink', 4.5, 'footer wordmark, mark and column headings']
];

let failures = 0;

for (const [label, selector] of [['LIGHT', ':root {'], ['DARK', ':root[data-theme="dark"] {']]) {
  const base = tokensIn(':root {');
  // The dark block only redefines what changes, so anything it omits is
  // inherited from :root — same as in the browser.
  const tokens = label === 'LIGHT' ? base : { ...base, ...tokensIn(selector) };

  console.log(`--- ${label} ---`);
  for (const [fg, bg, need, role] of PAIRS) {
    if (!tokens[fg] || !tokens[bg]) {
      console.log(`  SKIP  ${fg} on ${bg} — not a literal colour in this theme`);
      continue;
    }
    const ratio = contrast(tokens[fg], tokens[bg]);
    const pass = ratio >= need;
    if (!pass) failures += 1;
    console.log(
      `  ${pass ? 'ok  ' : 'FAIL'} ${ratio.toFixed(2)}:1 (needs ${need})  ${fg} on ${bg} — ${role}`
    );
  }
}

console.log(failures
  ? `\nFAILED: ${failures} pair(s) below WCAG AA`
  : '\nevery documented pair meets WCAG AA in both themes');
process.exit(failures ? 1 : 0);
