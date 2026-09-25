# UI / UX audit — mobile first (2026-09-25)

**Method.** `scripts/shoot-ui.mjs` builds the app against a fake Supabase and renders every route with awkward, realistic data:
- a 50-character store name, a 48-character product name, a ₱1,250,000 piece, zero stock;
- 11 orders, one in every state;
- applications with 200-character notes and long emails.

Each route was captured at 360 / 390 / 414 / 768 / 1280 px, in light and dark. It also measures horizontal overflow and which navigation bar is showing.

This audit was written from the 390 px and 1280 px captures, **before any change**. The results after the changes are at the end.

Priority: **P0** blocks a task · **P1** accessibility failure or major workflow break · **P2** significant friction · **P3** polish.

## Before

| # | Route / component | Current behaviour | Problem → user impact | Where | P | Change |
|---|---|---|---|---|---|---|
| 1 | `/admin` overview | The page scrolls sideways by **165 px** at 390 px. The review-queue list and the storage table are wider than the phone. | The whole console slides sideways under the thumb; the admin loses their place. | Mobile | **P0** | Fix the tracks that overflow: `minmax(0,1fr)`, truncate long names. |
| 2 | Console shell (`ConsoleShell`, `console.css` ≤64rem) | The sidebar turns into a sideways-scrolling row of pills. From "Billing" on, the pills sit off-screen, with no scroll hint. | Half the destinations can't be found: Billing, Plan, Models, Activity and Usage are all off to the right. | Mobile | **P1** | A **workspace tab bar** at the bottom (four destinations plus **More**), and a compact top bar. The pill scroller is removed. |
| 3 | Console shell | Sign Out is a large pill beside the store name, above the navigation. | A destructive session action competes with the task navigation and sits where the thumb goes first. | Mobile | P2 | Move it into **More**, with the account email. |
| 4 | `/portal` | The store name appears **three times** in the first 300 px: the rail, an eyebrow pill wrapping over two lines, and the org line. Then "Welcome Back". | The first screen is identity, not work. The first action is at about 470 px. | Mobile | P1 | One compact header: the store name and "Store portal". The first thing below it is **Needs attention**. |
| 5 | `/portal` | The page is **10,079 px** tall at 390 px: 5 bento cards stacked full width, 7 inventory cards, 11 order cards, billing. It also scrolls sideways by 9 px (the Add Product pill and the reminder run off the right edge). | Getting to Orders or Billing is a long scroll; the sideways slide hides content. | Mobile | **P1** | A "Needs attention" list: models missing, orders waiting, PayPal. A compact 2-column snapshot. The tab bar jumps straight to each section. Closed orders collapse behind a disclosure. Fix the overflow. |
| 6 | Portal bento | Four figures at equal weight, each a full-width card on a phone. The hero figure is 70 px tall. | A lot of scrolling to read four numbers. | Mobile | P2 | A 2×2 grid of plain figures on phones. Only the AR-readiness card stays a frame. |
| 7 | Inventory cards | Every product becomes six label/value rows, with Edit and Delete side by side at equal weight. | Slow to scan; Delete sits right next to the most-used button. | Mobile | P2 | A card with the name and price in the header, then size, stock and AR status in one line. **Edit** is the primary action; Delete is secondary, set apart, and still confirmed. |
| 8 | Product form (`ProductFormDialog`) | Opens as a modal with a 20 px gap all round; the header scrolls away. | It feels like a tiny desktop modal, and there's no Cancel once you scroll. | Mobile | P2 | A **full-screen sheet** on phones, with the header (Cancel, title) fixed at the top. Save stays fixed at the bottom. |
| 9 | Store orders | 11 orders, every one expanded, closed ones included. | The ones that need action get buried under history. | Mobile | P2 | Open orders first; closed orders behind a "Past orders (n)" disclosure. |
| 10 | Payment reminder (mine) | A 3 px coloured left border. | Violates the design-review "Refuse" list (a coloured side border thicker than 1 px). | Both | P3 | Use a 1 px border and the status chip. |
| 11 | PayPal Disconnect (owner and admin) | Uses `window.confirm`. | Violates BRAND §9: browsers can suppress it, which would let an irreversible action through with no prompt. | Both | **P1** | Use the existing `ConfirmDialog` (Cancel takes focus). |
| 12 | Admin tables on phones (Stores, Models, Usage, Billing, Activity) | Each cell becomes a row **with no label**, because `data-label` is set only on inventory cells. Numbers stand alone ("₱160,050.00", "₱14,550.00", "₱0.00"…). "RECORD PAYMENT…" is clipped. | The data can't be read: nobody can tell sales from accrued fees. | Mobile | **P1** | `PagedTable` labels every cell from its column header. The first cell becomes the card's title. Action buttons wrap instead of clipping. |
| 13 | `/admin` overview | Leads with a lede about how figures are counted, then a "Review Applications" CTA, then the queue card. | The decision (3 applications) sits below a paragraph. | Mobile | P2 | "Needs a decision" first: the count and Review. The system figures come after. |
| 14 | Application review | Identity is first and the actions are at the end of each card. Approve and Reject already confirm. | Acceptable. Long notes are shown in full. | Mobile | P3 | Keep as is. Long notes wrap correctly. |
| 15 | `/furniture/[slug]` | On a phone the order is: photo → name → price → description → spec table → **Buy panel** → Measure my space. Buy is about 1000 px down. The status line uses an em-dash ("No 3D model — cannot…"). | The main purchase action is below the specs; the em-dash breaks BRAND §8. | Mobile | P1 | On phones, move the purchase panel up to just after the price (CSS `order`, no change to the markup). Rewrite the status line without the dash. |
| 16 | `/login` chooser | The intro paragraph on the forest band is **nearly invisible** (low-contrast ink on `--deep`). Continue with Google sits below both role cards, about 780 px down. | A WCAG AA contrast failure; the quickest way in is hidden. | Mobile | **P1** | Use `--on-deep-muted` for the band's text. Put Google directly under the heading, above the cards. |
| 17 | `/collection` "In the shops now" | The first card is cut off at the left edge on load. | Looks broken. | Mobile | P3 | Start the rail at the gutter (scroll-padding). |
| 18 | `/account` | Identity, then all orders, then profile. | Right order. But an order that needs payment isn't lifted above the others. | Mobile | P2 | Sort: needs payment first, then active, then past. |
| 19 | `/diagnose` | The recommended mode is the first card; the evidence is below it. | Already right. | — | — | Keep. |
| 20 | Public header and bottom nav | The bottom bar is hidden on workspace routes; there's no competing bar. | Right. | — | — | Keep. The workspace tab bar uses the same slot. |
| 21 | Desktop console | Left rail, clear active state, 1480 px max width. The portal's "Welcome Back" heading is generic. | Minor. | Desktop | P3 | The heading becomes the store's name; "Welcome Back" goes. |

## Navigation architecture

**Before.**
- Desktop: a left rail of links.
- Below 64rem: the same links as a sideways-scrolling pill row inside a frame at the top of the page, with Sign Out beside the store name.

**After.**
- Desktop (≥64rem): the left rail is unchanged. Sign Out stays at its foot.
- Phone and tablet (<64rem):
  - The rail frame is gone. A slim **workspace bar** shows the workspace name and org, plus an account button that opens the **More** sheet.
  - A fixed **workspace tab bar** sits at the bottom: the first four destinations and **More**. That is at most five slots, the same as the shopper bar, in the same position, with the same safe-area padding.
  - More holds the remaining destinations (portal: Plan; admin: Models, Usage, Activity), the account email and Sign Out.

| Workspace | Tab bar | More |
|---|---|---|
| Store portal | Overview · Inventory · Orders · Billing | Plan, account, Sign Out |
| Superadmin | Overview · Applications · Stores · Billing | 3D Files, Usage, Activity, account, Sign Out |

Every destination is an existing route or anchor; none were invented. The public bottom bar stays hidden on `/portal` and `/admin` (ChromeGate), so there is only ever one bottom bar.

## After

Re-rendered with the same data at 320 / 360 / 375 / 390 / 414 / 430 / 768 / 1024 / 1280 / 1440 / 1920 px: 14 screens, 308 captures, light and dark.

**Horizontal overflow: 0 px on every screen at every width.** Before: `/admin` 165 px, `/portal` 9 px (77 px at 320). Every workspace width shows exactly one bottom bar; no public page shows the workspace bar.

| # | Status | What changed |
|---|---|---|
| 1 | Fixed | The root cause was grid tracks sized by content. `.console-main`, `.console-overview`, `.console-section`, `.console-list`, `.orders-list` and `.order-card` now use `minmax(0, 1fr)`, so one long name can't widen the whole console. |
| 2 | Fixed | `WorkspaceTabBar` in `ConsoleShell`: a fixed bottom bar with four tabs and More, plus a More `<dialog>` sheet. It is portalled to `<body>`, because the view's entry animation leaves a transform that would otherwise pin a fixed bar to the bottom of the page. The pill scroller is gone. |
| 3 | Fixed | Sign Out is in the More sheet with the account email. On desktop it stays at the foot of the rail. |
| 4 | Fixed | The h1 is the store name, with "Store Portal" as the one label above it. "Welcome Back" and the repeated eyebrow are gone. |
| 5 | Fixed | **Needs attention** comes first, built only from real data: open orders, listings without a 3D model, out-of-stock listings. Each row links to where it gets fixed; when nothing is waiting it says so. The payment reminder sits above it. At 390 the page is 8,815 px tall, down from 10,079. |
| 6 | Fixed | On phones the AR hero spans the full width and the four figures sit two to a row. The catalog value drops `.00` so it no longer breaks mid-number. |
| 7 | Fixed | Inventory cards: name and category on top, then a 2×2 of size, price, stock and last update. **Edit** is a wide accent button; **Delete…** is quiet red text at the far end and still opens `ConfirmDialog`. There's no frame around the stack of cards. |
| 8 | Fixed | On phones (≤40rem) the product form is a full-screen sheet with a pinned top bar (Cancel, title) and a pinned Save that clears the safe area. Inputs are 16 px; W/D/H stack at full width instead of squeezing. The desktop two-column layout is unchanged. |
| 9 | Fixed | Open orders are listed first. Closed ones sit behind a "Past orders (n)" disclosure; when nothing is open, a line says so. |
| 10 | Fixed | The reminder border is now 1 px, tinted with `--warn`. |
| 11 | Fixed | Owner and admin PayPal Disconnect use `ConfirmDialog`, with Cancel focused first. The buyer's order Cancel / Withdraw, which had no confirmation at all, uses it too. No `window.confirm` or `alert()` is left in `app/`. |
| 12 | Fixed | `PagedTable` copies each column name from `<thead>` into the cells' `data-label`. The first cell becomes the card's title. Action buttons wrap instead of clipping. |
| 13 | Fixed | The admin overview's lede states the count ("3 applications need a decision"), and the queue is the first tile, with a primary **Review Applications** button. The duplicate header button is gone. The note on how figures are counted moved to Platform Health. |
| 14 | Kept | Nothing to change. |
| 15 | Fixed | The purchase panel moved directly under the price and availability, on every width. The status line is rewritten without the dash. |
| 16 | Fixed | The band paragraph uses `--on-deep-muted`. **Continue with Google** is directly under the heading, above the two role cards, with an "or choose your side" rule. |
| 17 | Not a defect | The "In the shops now" strip is an auto-scrolling marquee with a deliberate edge fade. The first card enters from the faded edge by design. |
| 18 | Fixed | Buyer orders are sorted: payment needed first, then in progress, then finished. |
| 19–20 | Kept | — |
| 21 | Fixed | Same as 4. |

**New tokens.** `--scrim` is the dim behind a dialog or sheet. It is declared on `:root` and on `::backdrop`, because an older backdrop inherits nothing. No new colour literals.

**Tab labels.** At 320 px each of the five tab slots is about 60 px wide. The admin Applications tab therefore reads **Queue**, the same name as the overview's Review Queue tile. The rail keeps the full name. Tab text is 11 px, the floor this project's mobile audit uses.

## Verification

All 14 checks below exit 0 on the final build. `node --test tests/*.test.js`: 408 tests, **385 pass, 0 fail**, 23 skipped (the suites that need a migrated Postgres).

Checks: `check:contrast`, `check:mobile`, `audit:mobile`, `check:portal`, `check:admin`, `check:nav`, `check:dashboard`, `check:home`, `check:access`, `check:billing`, `check:model-form`, `check:planner`, `check:diagnose`, `check:chrome`.

Checks updated to match the new layout:
- `check-dashboard`: the phone assertions now cover the tab bar being at the bottom of the screen, 4 tabs + More, More opening a sheet, Sign Out being inside it, Escape closing it, and figures pairing up. The desktop selectors are scoped to the rail.
- `check-portal`: the store name is now the page heading.
- `check-billing`: a delivered order is found under Past orders.
- `audit-mobile` had three stale steps that stopped it before this work began:
  - the bottom bar's /portal item was removed with buyer accounts;
  - the catalogue moved to /collection;
  - the header's hidden search field was being measured instead of the catalogue's.

  It also counted the unit radio group as three fields, and didn't recognise `inputmode="decimal"` as a number pad.

`audit:mobile` now finds no P0 or P1. It found two P2s from this pass, now fixed: the "New store? Sign up" link was 24 px tall, and "W × D × H" was 9 px.

## Design review score (design-review skill)

| Dimension | Score | Notes |
|---|---|---|
| Accessibility | 4 | Contrast is AA in both themes. Tabs are 56 px tall with `aria-current`. More is a real `<dialog>` (Escape closes it, focus comes back to the opener). Every irreversible action uses `ConfirmDialog`. Motion on the sheet respects reduced motion. |
| Performance | 4 | No new client boundaries. The blur is only on the fixed bar. The layout work is grid tracks, not script. `PagedTable` labelling is one pass over at most 10 rows. |
| Theming | 4 | Token-only; the new `--scrim` replaced two literals. Dark mode was checked by eye at 360, 390 and 1280. |
| Responsive | 4 | 0 px overflow on 14 screens × 11 widths. Every target is at least 44 px. The product form is a full-screen sheet on phones. |
| Integrity | 3 | Every figure and every attention row is counted from real data, and every link goes to an existing route or anchor. One P2 is open in the AR planner (below). |
| **Total** | **19 / 20** | No P0, no P1. |

## Remaining

- **P2.** `/plan` (AR): "Use this room" sits in the top 40% of the screen. The live camera screen was left untouched in this pass; moving it needs a device test.
- **P3.** Store order cards still show every detail. A per-card disclosure (contact and address behind "Details") would shorten the list further.
- **P3.** Buyer email addresses in order cards break mid-address on narrow phones, because they are shown in full on purpose.
