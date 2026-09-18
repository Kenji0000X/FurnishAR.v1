# FurnishAR — brand and interface kit

The single source of truth for the tokens is the `:root` block in
`public/styles.css`. This document explains what each token is for and records
the measured numbers behind the decisions. If the two ever disagree, the
stylesheet is right and this file is stale.

---

## 1. The design thesis

Three ideas, one rule each, so they never fight:

| Idea | Its one rule |
| --- | --- |
| **Minimalism** — carries the page | One paper, one ink, one accent. Two typefaces, few sizes. Space separates things, not boxes or colour. |
| **Brutalism** — the structure, in small doses | Anything sitting *on* the page is square-cornered and drawn with a 1px ink rule. Emphasis is a hard offset block, never a blur. |
| **Glassmorphism** — the z-axis | Only surfaces that float *above* content are frosted. **If it is frosted, it is floating. If it is flat, it is part of the page.** |

That last line is the load-bearing rule. It is what stops the glass reading as
decoration: frosting is not a style here, it is a statement about depth. The
sticky header, dialogs, the toast, the AR badge, the measurement tags and the
whole AR layer are frosted. Cards, forms, tables and panels are flat.

---

## 2. Logo and mark

The mark is three bars — tall, short, tall — in a 16px box, 4px wide with 2px
gaps. The third bar is `--accent` on light grounds and `--accent-lifted` on
dark. The wordmark is `FurnishAR`, DM Sans 700, `-0.035em` tracking, with `AR`
in the accent.

**Do:** keep the mark and wordmark on one baseline with a 0.55rem gap. Give the
lockup clear space of at least the mark's own width on every side.

**Don't:** re-colour the bars individually, add a third colour, outline the
wordmark, set it in another face, or place the light-ground mark on a dark
ground (use the lifted accent instead).

---

## 3. Colour

Every one has a job; none are decorative alternates. `scripts/check-contrast.mjs` measures each pair below out of the live stylesheet, in both themes, and the numbers in these tables are its output.

### Surface
| Token | Value | Use |
| --- | --- | --- |
| `--paper` | `#f2f1ec` | The page. |
| `--paper-raised` | `#fbfaf7` | Anything sitting on the page: cards, forms, table bodies, dialog content. |
| `--paper-sunken` | `#e7e5dd` | Recesses: product artwork wells, the measurement strip, the room scene. |

### Ink
| Token | Value | Use |
| --- | --- | --- |
| `--ink` | `#141413` | Body copy, headlines, hairline rules, the hard shadow, inverted blocks. |
| `--ink-muted` | `#5d5b53` | Secondary prose. |
| `--ink-faint` | `#68655c` | Every mono micro-label. |

### Accent
One hue cannot serve every background, so it exists in three weights. Picking
the wrong one is the most likely way to break contrast.

| Token | Value | Use |
| --- | --- | --- |
| `--accent` | `#c0502a` | Fills and **large** display type only: the hero emphasis, the nav underline, accent blocks. |
| `--accent-ink` | `#b44a26` | **Small** accent text on paper: condition icons, link hovers, focus rings. |
| `--accent-lifted` | `#e08159` | Accent on the deep tone: band eyebrows, step links, portal marks. |
| `--on-ink-accent` | `#e08159` light / `#b44a26` dark | Accent on an **`--ink` ground**: the footer wordmark, its mark, the footer column headings. Its own token because `--ink` is one of the two tokens that invert between themes, so a block painted `background: var(--ink)` is dark by day and light by night — `--accent-lifted` alone reads 6.54:1 on one and 2.09:1 on the other. |
| `--on-accent` | `#ffffff` | Text sitting on an accent fill. Never `--paper` — it fails at 4.20:1. |
| `--deep` | `#12332c` | Inverted informational **blocks**: the fit verdict, the portal panel. |
| `--band` | `#12332c` light / `#1b2b26` dark | The ground under a full-bleed home-page **band**. A block sits *on* the page; a band *is* a stretch of it, and all a band has to do is read as a different stretch. In the light theme `--deep` does that unaided; in the dark theme it is 1.02:1 against the page — two shades of the same black. The dark value lifts instead of sinking. |
| `--on-deep` | `#eef2ef` | Text on `--deep` and `--band`. |
| `--on-deep-muted` | `#c6d0cc` | Secondary prose on `--deep` and `--band`. Written as a flat colour, not `rgba(…, .82)`: a composited alpha is not a colour any contrast tool can measure without knowing what it landed on. |

### Measured contrast

Every pair below is computed from the live token values (WCAG 2.1 relative
luminance). Large = ≥24px, or ≥18.66px at 700.

| Pair | Ratio | Result |
| --- | --- | --- |
| `--ink` on `--paper` — body text | 16.30:1 | PASS (needs 4.5) |
| `--ink-muted` on `--paper` — secondary text | 6.02:1 | PASS (needs 4.5) |
| `--ink-faint` on `--paper` — micro-labels | 5.15:1 | PASS (needs 4.5) |
| `--ink-faint` on `--paper-raised` — on cards | 5.58:1 | PASS (needs 4.5) |
| `--ink-faint` on `--paper-sunken` — on recesses | 4.62:1 | PASS (needs 4.5) |
| `--accent-ink` on `--paper` — small accent text | 4.70:1 | PASS (needs 4.5) |
| `--accent` on `--paper` — display accent | 4.20:1 | PASS (needs 3, large only) |
| `--on-accent` on `--accent` — text on accent fill | 4.75:1 | PASS (needs 4.5) |
| `--paper` on `--ink` — text on ink blocks | 16.30:1 | PASS (needs 4.5) |
| `--paper` on `--deep` — text on deep blocks | 12.09:1 | PASS (needs 4.5) |
| `--on-ink-accent` on `--ink` — accent on ink | 6.54:1 | PASS (needs 4.5) |
| `--on-deep` on `--deep` — text on deep panels | 12.10:1 | PASS (needs 4.5) |
| `--on-deep` on `--band` — text on the bands | 12.10:1 | PASS (needs 4.5) |
| `--on-deep-muted` on `--band` — secondary text on the bands | 8.66:1 | PASS (needs 4.5) |
| `--accent-lifted` on `--band` — band eyebrows and step links | 4.85:1 | PASS (needs 4.5) |
| `--danger` on `--paper-raised` — form errors | 6.07:1 | PASS (needs 4.5) |

`--ink-faint` is the tightest constraint in the system: it carries every
micro-label, including on the sunken tone at 4.62:1. **Do not lighten it.**

### The dark theme

Only the tokens change. Not one layout or component rule is themed, which is
the payoff for having had a token layer to begin with — and the reason the two
themes cannot drift apart as components are added.

Two selectors, in this order and for this reason:

- `:root[data-theme="dark"]` — an explicit choice, made with the toggle.
- `@media (prefers-color-scheme: dark)` scoped to `:root:not([data-theme="light"])`
  — the OS preference, which must never override someone who has explicitly
  asked for light.

The stored value is `'light'`, `'dark'`, or absent. Absent means "follow the
OS" and is not the same as light; collapsing the three to a boolean is how a
dark-mode visitor who never touched the toggle gets permanently pinned to dark.

The surfaces keep some of `--deep`'s green rather than inverting to neutral
black, so it reads as the same brand at night. The hard offset shadow inverts
to light, because an ink shadow on a dark page is invisible.

| Pair | Ratio | Result |
| --- | --- | --- |
| `--ink` on `--paper` — body text | 16.08:1 | PASS (needs 4.5) |
| `--ink-muted` on `--paper` — secondary text | 9.35:1 | PASS (needs 4.5) |
| `--ink-faint` on `--paper` — micro-labels | 7.09:1 | PASS (needs 4.5) |
| `--ink-faint` on `--paper-raised` — on cards | 6.36:1 | PASS (needs 4.5) |
| `--ink-faint` on `--paper-sunken` — on recesses | 7.39:1 | PASS (needs 4.5) |
| `--accent-ink` on `--paper` — small accent text | 7.71:1 | PASS (needs 4.5) |
| `--accent` on `--paper` — display accent | 4.74:1 | PASS (needs 3, large only) |
| `--on-accent` on `--accent` — text on accent fill | 4.91:1 | PASS (needs 4.5) |
| `--on-ink-accent` on `--ink` — accent on ink | 4.71:1 | PASS (needs 4.5) |
| `--on-deep` on `--deep` — text on deep panels | 15.82:1 | PASS (needs 4.5) |
| `--on-deep` on `--band` — text on the bands | 13.09:1 | PASS (needs 4.5) |
| `--on-deep-muted` on `--band` — secondary text on the bands | 9.36:1 | PASS (needs 4.5) |
| `--accent-lifted` on `--band` — band eyebrows and step links | 6.27:1 | PASS (needs 4.5) |
| `--danger` on `--paper-raised` — form errors | 7.08:1 | PASS (needs 4.5) |

Both tables are generated by `npm run check:contrast`, which parses the token
values straight out of `styles.css` rather than keeping a second copy of the
palette. Run it after touching any colour. It reproduces the light table above
exactly, which is what makes it trustworthy for the dark one.

The AR layer is exempt. It overlays a camera feed and is dark in both themes by
design — see §7.

---

## 4. Typography

Two families, loaded as one request from Google Fonts.

| Role | Face | Setting |
| --- | --- | --- |
| Display and UI | **DM Sans** | 700 for headings at `-0.03em` to `-0.05em`; 400/500 for prose. |
| Data and labels | **DM Mono** | 400/500. Every number a person might compare — prices, dimensions, measurements, stats — and every micro-label. |

**The micro-label rule.** Eyebrows, store names, table headers, filter labels,
tray labels and status chips are all one recurring thing: DM Mono, `0.625rem`,
`0.14em` tracking, uppercase, `--ink-faint`. It is the interface's connective
voice and the main reason the page reads as one system. It is defined once as a
shared selector list, not re-declared per component.

Headings are fluid: `clamp(2.6rem, 8.5vw, 5.25rem)` for the hero,
`clamp(1.75rem, 4vw, 2.6rem)` for section titles. Body is `0.9375rem/1.55`.

Numbers set in mono must never be re-set in the sans — a price in DM Sans in one
place and DM Mono in another is the fastest way to make the product look
assembled by different people.

---

## 5. Space and structure

- Page gutter: `clamp(1.15rem, 5vw, 4.5rem)`. Max width: `1340px`.
- Sections are separated by a **1px ink rule**, not by cards or colour.
- Structural corners are square. Radius is `0` everywhere on the page. The only
  curves in the product are the AR reticle and the place button, which are
  round because they are camera instruments, not page furniture.
- **One shadow exists:** `--hard`, a `5px 5px 0` ink offset with no blur. It
  appears on hover for buttons and cards, and on dialogs. There are no blurred
  shadows anywhere.
- Grids that always fill their columns (planner steps, dimension cells,
  conditions) may use the shared-hairline trick — a 1px gap over a ruled
  container. Grids with a variable item count (catalog, inventory stats) must
  use real gaps and bordered items, or a half-empty row shows the container
  colour as a slab.

### Bands

A **band** is a full-bleed section on `--band`. The home page alternates:
paper, band, paper, paper, band, footer.

The alternation is structure, not decoration. A band is reserved for the two
moments the page **says** something rather than **listing** something — here
is how this works, here is what to do next. Reading and comparing stay on
paper. A third band would make the rhythm a stripe pattern and cost the other
two their meaning.

Full-bleed, but the content inside is still held to `--maxw`: a band must
never widen the measure of its own text.

### Grid tracks

Write `minmax(0, 1fr)`, never a bare `1fr`, on any track whose children can be
wider than the viewport — fixed-width art, a `<select>` as wide as its longest
option, a card with a long word in it. A track's default minimum is
`min-content`, so `1fr` is really `minmax(auto, 1fr)` and one stubborn child
pushes the whole page sideways. Three separate rules had this, and together
they scrolled the home page 102px sideways at 320px. `npm run check:home`
measures every route at five widths so it cannot come back.

---

## 6. Motion

Three durations, three curves. Nothing else.

| Token | Value | Use |
| --- | --- | --- |
| `--dur-press` | `90ms` | The press itself. |
| `--dur-fast` | `150ms` | Hover, colour, border changes. |
| `--dur-base` | `220ms` | Dialogs, view changes, toast, the AR layer. |
| `--ease-out` | `cubic-bezier(.22, 1, .36, 1)` | Everything entering. Lands softly. |
| `--ease-in` | `cubic-bezier(.4, 0, 1, 1)` | Everything leaving. Gets out of the way. |
| `--ease-pop` | `cubic-bezier(.34, 1.4, .64, 1)` | A hair of overshoot. Presses and the toast only. |

**Rules:**

1. **Animate `transform` and `opacity` only.** They stay on the compositor, so
   nothing reflows mid-gesture. Never animate width, height, top or margin.
2. **Enter out, leave in.** Entrances use `--ease-out`, exits `--ease-in`. A
   dialog that leaves on the same curve it arrived on feels sticky.
3. **Move a little.** Dialogs travel 8px and scale 2%. Views rise 6px. Enough to
   read as motion, small enough that nothing jumps.
4. **Sequence sparingly.** In the AR layer the camera fades first and the glass
   panels follow 80ms later, so the view reads as camera first, controls
   second. That is the only stagger in the product.
5. **Reduced motion means no movement, not no feedback.** Under
   `prefers-reduced-motion: reduce`, every transform and keyframe stops, but
   colour, border and shadow changes stay, so nothing loses its state.

---

## 7. Surfaces

| Surface | Treatment |
| --- | --- |
| On the page | `--paper-raised`, 1px `--rule` border, square, no shadow. |
| Floating (light) | `--glass` at 68% with `blur(20px) saturate(165%)`, a `--glass-line` border. Header, dialogs, toast, AR badge, measure tags. |
| Floating (over camera) | `--glass-dark` at 46% with `blur(18px) saturate(150%)`, `--glass-dark-line` border, `--glass-dark-text`. The whole AR layer. |
| Inverted | `--ink` (footer) or `--deep` (verdict, portal) with `--paper` text. |

The AR layer is the same system inverted over a live camera: square glass
panels, mono tracked labels, the same durations and curves. It should never
read as a different product.

---

## 8. Voice

Short, factual, specific. The interface states what is true and what to do
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
