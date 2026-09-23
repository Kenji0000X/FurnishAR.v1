# FurnishAR: brand and interface kit

The single source of truth for the tokens is the `:root` block in
`public/styles.css`. This document explains what each token is for and records
the measured numbers behind the decisions. If the two ever disagree, the
stylesheet is right and this file is stale.

---

## 1. The design thesis

**Calm, architectural, and about the furniture.** The page is cool and quiet
so that the one warm thing on it, the actual wood and fabric of a listed
piece, is what you look at.

| Idea | Its one rule |
| --- | --- |
| **One accent** | Forest green, used for the one action that matters on a screen and for display emphasis. Never decorative, never a second accent beside it. |
| **Objects, not boxes** | Things that sit *on* the page (a product, a promise, the 3D viewer) are nested frames: an outer shell and an inner core with a concentric radius. Text is grouped by space, not by drawing boxes round it. |
| **Glass means floating** | Only surfaces that float above content are frosted: the header island, dialogs, alerts, the AR layer. If it is frosted, it is floating. |

Landing pages (home, catalogue, product) follow the anti-template rules in the
design skills used for the overhaul: a hero is one message and one action, at
most one eyebrow label per three sections, one label per intent (the planner is
always "Measure my space"), no version stamps, no scroll cues.

---

## 2. Logo and mark

The mark is three bars, tall, short, tall, in a 16px box, 4px wide with 2px
gaps. The third bar is `--accent` on light grounds and `--accent-lifted` on
the forest band. The wordmark is `FurnishAR`, Geist 700, `-0.035em` tracking,
with `AR` in the accent.

**Don't:** re-colour the bars individually, add a colour, outline the
wordmark, or set it in another face.

---

## 3. Colour

Cool slate surfaces, one forest accent. The warm cream, brown and espresso
family this replaced is the palette almost every furniture site ships; it made
FurnishAR look like all of them, and it competed with the furniture.

### Surface (light / dark)
| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--paper` | `#eef1f3` | `#0d1113` | The page. |
| `--paper-raised` | `#f9fafb` | `#151b1e` | Cores of cards and frames, forms, dialogs. Never pure white. |
| `--paper-sunken` | `#e0e5e8` | `#090c0e` | Recesses: product wells, the viewer stage. |

### Ink
| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--ink` | `#121719` | `#eaeff0` | Body copy and headlines. Never `#000`. |
| `--ink-muted` | `#3a444a` | `#c0cacd` | Secondary prose. |
| `--ink-faint` | `#48535a` | `#a3aeb2` | Every mono micro-label; held above 4.5:1 everywhere. |

### Accent
| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--accent` | `#1d5c4b` | `#5fc3a0` | Fills and **large** display type. |
| `--accent-ink` | `#1a5243` | `#86d6ba` | **Small** accent text on paper. |
| `--accent-lifted` | `#8fd9bf` | `#86d6ba` | Accent on the forest band and the footer. |
| `--on-accent` | `#f7faf9` | `#0d1113` | Text on an accent fill. |
| `--band` / `--deep` | `#15332b` | `#13201b` / `#16241f` | The forest band: the footer (in both themes) and the deep promise cell. |
| `--focus-ring` | `#1d4f7a` | `#9cc8f0` | Focus indicators, deliberately not the accent so focus never reads as "selected". |

Status colours (`--ok`, `--warn`, `--danger`) are reserved for alerts and
always travel with an icon and a title, never colour alone.

### Measured contrast

`npm run check:contrast` computes every documented pair from the live tokens,
in both themes, and fails below WCAG AA. At the overhaul the lowest pair was
`--on-ink-accent` on `--ink` in dark mode at 7.76:1; `--accent` on `--paper`
is 6.90:1 light and 8.86:1 dark; `--on-accent` on `--accent` is 7.45:1.

The two dark blocks (`[data-theme="dark"]` and the `prefers-color-scheme`
query) hold identical values. They had drifted apart before, and the system
one had no focus ring at all.

---

## 4. Typography

**Geist Sans** for everything, **Geist Mono** for figures and micro-labels.
Both are self-hosted through `next/font` (the `geist` package): no request to
a font CDN, and fallback metrics adjusted so nothing jumps when they load.

- Display: tight tracking (`-0.05em`), leading near 1, `text-wrap: balance`.
  A hero headline is two lines, never three.
- Body: 1.0625 to 1.125rem, `--ink-muted`, max ~65ch, `text-wrap: pretty`.
- Micro-labels: Geist Mono, `--micro`, uppercase, `.14em` tracking,
  `--ink-faint`. Used for data labels, not above every heading.

---

## 5. Shape and space

One radius system, and it is followed everywhere:

| Thing | Radius |
| --- | --- |
| Anything you press to go somewhere (capsules, buttons, the header island) | pill |
| Frames: outer shell / inner core | `--radius-lg` 28px / 22px (shell minus its 6px padding) |
| Panels, spec strips, the shop card | `--radius` 16px |
| Inputs | `--radius-sm` 10px |

Shadows are soft and tinted toward the slate (`--hard`, `--hard-sm`), never
black on a light page. Sections breathe: landing sections are at least 70svh
or carry generous vertical padding; the catalogue is denser by design.

The primary action on a landing page ends in its own arrow circle
(`app/CtaArrow.js`, a Phosphor icon), flush with the pill's inner edge. It
shrinks inside compact `.button`s so a row keeps one height.

---

## 6. Motion

Motion only says something: an element arriving, a press, a state change.

- Scroll reveal (`app/RevealObserver.js`): one IntersectionObserver, a short
  fade, lift and de-blur on a `cubic-bezier(.32, .72, 0, 1)` curve, once. It
  does nothing under reduced motion and is always shown in print.
- Hover: primary CTAs nudge their arrow up and right; product wells lift 3px.
- The home page's 3D room renders only while its own layer is on screen.
- Only `transform`, `opacity` and `filter` animate. Everything collapses to
  static under `prefers-reduced-motion`.

---

## 7. Surfaces

- **Header:** a frosted island on desktop, detached from the edges; its height
  plus its top gap equal `--header-h`, so every offset built on that token is
  unchanged. On phones it is a full-width bar with the bottom navigation.
- **Footer:** the forest band in both themes. The build version is a
  `data-build` attribute, not visible text.
- **Alerts, dialogs, the AR layer:** frosted, because they float.

---

## 8. Voice

Short, factual, specific. No em-dashes in anything a shopper reads on the
home, catalogue or product pages: two sentences, a comma or a colon instead. The interface states what is true and what to do
next, and stops.

**Do:** "Flat surface found. Tap to place." · "Readings differ by 8%. Scan
again." · "70 × 78 × 88 cm."

**Don't:** emoji in UI copy, exclamation marks, "Oops!", "Awesome!", hedging
("it seems that…"), or three sentences where one works. Status text is one
line. Never blame the person for a failure the app could not avoid.

Numbers always carry their unit, and centimetres are the product's unit
everywhere except the AR readout, which shows m / cm / mm together because a
person judging a room needs all three.

---

## 9. Accessibility contract

Not aspirations — these are checked in the browser and currently pass:

- **Contrast:** every text pair meets WCAG AA (table in §3). Non-text marks meet 3:1.
- **Target size:** no interactive control is under 24×24 CSS px on any pointer
  (WCAG 2.2 AA), and every control clears 44×44 on coarse pointers.
- **Focus:** every tab stop shows a visible indicator — a 2px `--accent-ink`
  outline at 2px offset, or, for the search field, a ring on the wrapper so the
  whole field reads as focused. An indicator is never removed without an
  equally visible replacement.
- **Dialogs:** focus moves to the dialog heading on open, Escape closes, and
  focus returns to the control that opened it.
- **AR:** Escape leaves the AR layer, matching every other overlay.
- **State:** the active nav item carries `aria-current="page"`; form errors are
  `role="alert"` and mark their field `aria-invalid`; the catalog sets
  `aria-busy` while loading.
- **Loading:** the catalog renders a skeleton in the shape of the real card, so
  the layout never shifts when data arrives. (This was documented here long
  before it was true: the `.skeleton-*` rules existed but nothing rendered
  them. `app/loading.js` is the markup they were written for.)
- **Zoom:** the page never blocks pinch-zoom (WCAG 1.4.4). The AR view sets
  `touch-action: none` on its own camera surface instead, so a page-level
  zoom lock is not needed to keep its centimetre readout honest.
- **Themes:** every pair in both palettes meets AA — `npm run check:contrast`.
- **Destructive actions:** confirmed with a real `<dialog>`, never
  `window.confirm`, which browsers can suppress after a few uses and which
  would then let an irreversible action through with no prompt at all. Cancel
  takes focus, so a stray Enter backs out.

---

## 10. Using the kit

Tokens live in one place. To restyle the product, change `:root` in
`public/styles.css` — not the component rules. If you need a new colour, first
check whether an existing token has that job; if it genuinely needs a new one,
add it to `:root`, give it a documented role here, and measure its contrast
before shipping it.
