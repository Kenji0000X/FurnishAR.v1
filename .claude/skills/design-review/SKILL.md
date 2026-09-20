---
name: design-review
description: Use before shipping any UI change in FurnishAR — a new page, component, redesign, or "make it look better" request. Checks the built result against BRAND.md's rules and against a generic checklist of AI-slop patterns to refuse, then runs a scored audit across accessibility, performance, theming, responsiveness and consistency. Not for backend-only changes with no visible surface.
---

# Design review

This project already has a design system — `BRAND.md` — and it is the source
of truth for FurnishAR specifically: its tokens, its rule ("frosted = floating,
flat = part of the page"), its measured contrast tables. This skill does not
replace BRAND.md. It is the part BRAND.md doesn't cover: a checklist of things
that are wrong on *any* interface, not just this one, and a habit of actually
running the project's own checkers before calling a change done.

Adapted from two open-source Claude Code skills — [taste-skill](https://github.com/leonxlnx/taste-skill)
(MIT) and [impeccable](https://impeccable.style) (Apache-2.0) — trimmed to
what applies without their external binaries, and pointed at this repo's own
tokens and scripts instead of generic ones.

## Order of operations

1. Read `BRAND.md` first. It wins over everything below. If a rule here would
   contradict it (e.g. "no gradients" vs. a brand token that uses one), BRAND.md
   is right and this file is generic.
2. Build the change.
3. Run **Verify** below on the actual rendered result — not on the intention.
4. Check the change against **Refuse** — these are AI-generated-interface
   defaults, not FurnishAR rules; reaching for one without a reason means the
   choice was never made on purpose.
5. Run the project's own checkers (see **Tools already in this repo**) before
   saying a UI change is finished.

## Verify

Each of these is checked on the built page, in a real or emulated browser —
not asserted from reading the CSS.

- **Contrast** — body/placeholder text ≥ 4.5:1, large text ≥ 3:1, in *both*
  themes. Run `npm run check:contrast`; it measures every documented pair out
  of the live stylesheet. If a new component uses a token pair that isn't in
  `PAIRS` in `scripts/check-contrast.mjs`, add it — that's what caught the
  footer-accent and band-button failures in the home-page redesign.
- **Depth** — this project's one shadow is `--hard`, a flat offset with no
  blur (BRAND.md §1, §5). A soft/blurred shadow anywhere outside a frosted
  floating layer is a bug, not a style choice.
- **Spacing** — tight within a group, generous between groups, more space
  above a heading than below it. Read the computed values, don't eyeball them.
- **Type** — body measure roughly 65–75ch, tracking floor around -0.04em,
  obvious scale/weight steps between headings and body. Run the real copy at
  every breakpoint and fix whatever overflows or wraps badly.
- **Motion** — respects `prefers-reduced-motion` with an *intentional*
  alternative, not a `0.01ms` kill that also deletes the information the
  motion was carrying (see the FAQ's plus/minus icon for the pattern: the
  travel is removed, the end state is kept). Only `transform` and `opacity`
  animate by default; reach for anything else only if it's proven smooth.
- **States** — hover, disabled, loading, error, empty, and keyboard focus.
  Tab through the new UI; don't just click it.
- **Browser surfaces** — the parts nobody draws still carry the design:
  selection color, focus rings, scrollbars, `::-webkit-details-marker` on a
  `<details>`. Themed from the palette, not left at browser defaults. This is
  the cheapest tell that a page was actually finished.
- **Copy** — the product's own voice (BRAND.md §8), not filler. Controls name
  their action; errors name the problem and the recovery.
- **Coverage** — every requirement in the request is present and findable
  within seconds, not buried three clicks deep.
- **No sideways scroll** — check every route at 320/360/414/768/1024px. A bare
  `1fr` grid track will not shrink below its content's `min-content` width;
  use `minmax(0, 1fr)` on any track that might hold something wide (see
  BRAND.md's "Grid tracks" note under §5). `npm run check:home` measures this
  automatically for the routes it knows about.

## Refuse

These are defaults an LLM reaches for when no one decided otherwise — not
things FurnishAR's brand forbids for taste reasons, but things that are wrong
because they weren't a decision at all. If a `BRAND.md` rule actually calls
for one of these, BRAND.md wins; if a request explicitly asks for it, follow
the request. Reaching for one out of habit is the failure.

- **Section numbers (01 / 02 / 03) as decoration.** The planner and the home
  page's "How it works" band use them because the *sequence itself* is
  information — step 2 must happen before step 3. Numbering a set of things
  with no order (e.g. three unordered feature cards) is decoration wearing a
  system's clothes.
- **A kicker/eyebrow above every single heading, on reflex.** FurnishAR does
  use `.eyebrow` (BRAND.md's own mono micro-label), but not on every heading —
  only where it adds a real category the heading doesn't already say.
- **Same-size icon+heading+text cards as the whole page structure**, especially
  nested inside other cards. BRAND.md already asks for real gaps and bordered
  items over container-in-a-container.
- **Gradient text**, **glass/blur as decoration** rather than the specific "this
  is floating" signal BRAND.md defines, **hard offset shadows** used outside
  what BRAND.md actually calls for.
- **A colored border-left/border-right thicker than 1px** on a card or alert.
- **Monospace as a costume for "technical"** rather than for the mono
  micro-label role BRAND.md actually gives it.
- **Unicode glyphs standing in for an icon system** where the project has real
  ones. (FurnishAR does use a few plain glyphs deliberately — e.g. `→`, `⌑`
  — as part of its typographic voice; that's a brand choice already made, not
  a placeholder for a missing icon library.)
- **Placeholder/fabricated content**: fake stats, fake testimonials, a pricing
  tier or dashboard number nobody computed. If a number is shown, it must be
  derived from real data (see the home-page hero facts, which are counted
  from `getCatalog()`/`getStores()`, not typed in).
- **AI copywriting clichés** — "elevate", "seamless", "unleash", "next-gen",
  "game-changer", "delve". Say the specific thing instead.
- **A button, link, or control that does nothing**, or that points at a route
  or anchor that doesn't exist. Every new link gets resolved, not assumed —
  see `check-home-sections.mjs` for the pattern (it actually requests every
  href and checks every `#anchor` exists on the target page).

## Scored audit (for a larger review)

For a full pass rather than a single component, score 0–4 on each dimension
and total out of 20:

| # | Dimension | What to check |
|---|---|---|
| 1 | Accessibility | Contrast, `prefers-reduced-motion`, ARIA/roles, keyboard nav + focus order, heading hierarchy, alt text, labeled form fields with real error messages |
| 2 | Performance | Layout thrashing, expensive/unbounded animated filters, missing lazy-loading, `will-change` left on at rest, unnecessary client-component boundaries |
| 3 | Theming | No hard-coded colors outside `:root` tokens, dark theme actually verified (not just "should work"), tokens used consistently |
| 4 | Responsive design | No horizontal overflow at 320/360/414/768/1024px, touch targets ≥ 44×44px, text scaling doesn't break layout |
| 5 | Implementation integrity | Does this read as one coherent product, or as assembled/generic parts? Any decorative element that isn't backed by a real feature (see "DO NOT INVENT FEATURES" — the same rule applies to every future redesign, not just the one it was written for) |

Tag findings **P0** (blocks the task) / **P1** (WCAG AA violation or major
UX break) / **P2** (annoyance, workaround exists) / **P3** (polish, fix if
time permits). Don't report an issue without saying what it costs the user;
don't skip noting what already works well.

## Tools already in this repo

Run these instead of reaching for anything from outside — they're built for
this exact stylesheet and these exact routes:

- `npm run check:contrast` — measures every documented colour pair in both
  themes against WCAG AA, parsed live from `public/styles.css`.
- `npm run check:home` — drives the home page's interactive sections (the FAQ
  accordion, every link/anchor, the portal deep link) and measures horizontal
  overflow + tap targets across five widths. Extend this file's `PAIRS`/checks
  rather than starting a parallel script when reviewing a new section.
- `npm run check:mobile` — layout checks across phone viewports for the
  catalogue, planner, portal and product pages.
- `node --test tests/*.test.js` — unit tests, including `catalog-filter.test.js`
  for the search/filter logic.

A design review that doesn't end by running these is a design review that
skipped verification.
