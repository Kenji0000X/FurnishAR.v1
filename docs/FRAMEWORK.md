# Framework evaluation

*Asked: "the framework must be in Next.js — add a decent framework applicable to
this system, explore the others too."*

---

## 1. First, the thing that changes the answer

**No framework hides an API key from a browser.** If a page talks to Supabase,
the key is in the network request, and anyone can read it in DevTools. In
Next.js, `NEXT_PUBLIC_*` is *defined* as "inline this value into the JavaScript
sent to the browser" — the Supabase quickstart's `client.ts` does exactly that.

What hides a key is **a server**, not a framework. The key must never leave it.
That is now done (`lib/supabase-proxy.js`): the browser calls this app's own
`/api/sb/…` endpoints, and the server calls Supabase. Verified — the browser
receives no key, not even the project URL.

So "use Next.js" and "hide the key" were never the same requirement. The second
is solved. The first is now purely a question of what this codebase should be
written in.

## 2. What this app actually is

Judge a framework against the real workload, not a generic checklist:

| Part | Size | Nature |
| --- | --- | --- |
| AR engine (WebXR, three.js, hit-testing, the control tray, measurement) | ~1,400 lines | Imperative, frame-by-frame, owns its own DOM and a WebGL canvas |
| Design system | ~1,300 lines CSS | Hand-written tokens, documented in `BRAND.md` |
| Catalogue, planner, owner portal | ~600 lines | Ordinary forms and lists |
| API + proxy | ~450 lines | Node serverless functions |
| Tests | 51 | Node's test runner, no framework needed |

**Roughly two-thirds of this app is an imperative real-time graphics loop.**
That is the part a component framework helps least — React would wrap it in a
`useEffect` and otherwise stay out of the way. The third that *would* benefit is
the catalogue and portal.

## 3. The options

### Next.js (App Router) — what you asked for

**For:** first-class on Vercel, which you already use. Server Components and
Route Handlers are a natural home for the Supabase proxy. Every Supabase
tutorial, including the one in your dashboard, is written for it, so you can
copy-paste help. Image optimisation, routing and code splitting come free. It
is the most employable thing to have on a thesis.

**Against:** the AR layer gets no benefit and must be ported carefully into a
`'use client'` component with `dynamic(..., { ssr: false })` — WebXR and
three.js cannot server-render. You inherit a build toolchain, `node_modules`,
and a framework that changes fast; `docs/SUSTAINABILITY.md` currently rests on
"no runtime dependencies, nothing to rot", and that argument goes away.
Realistically a 2–4 day port with a real risk of regressing AR behaviour that is
currently verified by 51 tests.

### Astro — the closest fit on the merits

Ships zero JavaScript by default and lets you drop to a plain `<script>` for the
AR layer, so the existing code moves nearly as-is. Content-heavy pages (the
catalogue) get static generation; islands cover the interactive bits. Server
endpoints handle the proxy. This is what I would pick if the only criterion were
"best fit for this app".

**Against:** smaller ecosystem, fewer Supabase examples, and less recognisable
on a CV than Next.js.

### SvelteKit

Smallest bundles, the least ceremony, excellent for forms. Same AR caveat as
Next. Least common of the three in Philippine job listings.

### Stay vanilla

**For:** everything works, is measured, and has no dependency to update. The
sustainability argument in the thesis is real and unusual.
**Against:** no component model, so the portal will get harder to extend; and
"no framework" reads as a gap to some panels, fairly or not.

## 4. Recommendation

**Go with Next.js, but port in this order, and not all at once:**

1. **Done already — the server boundary.** `/api/sb/*` is the seam. In Next.js
   these become Route Handlers with almost no change; the browser code calling
   them does not care.
2. **Catalogue and product pages first.** Real gain: server-rendered product
   pages are shareable and indexable, which matters for shops being found.
3. **Owner portal second.** Forms and tables are what React is good at.
4. **AR layer last, and moved rather than rewritten.** It becomes one client
   component that mounts the existing code. Do not "Reactify" the frame loop —
   there is nothing to gain and a working AR experience to lose.
5. **Keep the tests.** `tests/geometry.test.js` and `tests/db.test.js` are
   framework-independent and should survive untouched. They are what will tell
   you the port did not break the measurement maths or the access rules.

**What not to do:** a big-bang rewrite. Two-thirds of this code is AR that gains
nothing from the migration, and it is the part your panel will actually be
shown. A half-ported app that loses AR is worse than either endpoint.

## 5. If you want Next.js now

The migration is a multi-day piece of work that will touch every file, so it
should be its own branch and its own decision — not a side effect of an API-key
fix. When you want it, the first commit should be:

```
npx create-next-app@latest furnishar-next --ts --app --tailwind=false
```

then move `lib/supabase-proxy.js` into `app/api/sb/[...path]/route.ts` (it is
already plain Node and needs only its request/response shapes changed), and
bring `public/geometry.js` across untouched.

**The key-hiding work does not need to wait for any of this, and hasn't.**
