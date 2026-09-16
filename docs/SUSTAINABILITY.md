# System sustainability

*Addresses: Ms. Vina A. Atienza — "System Sustainability".*

Sustainability here means four separate things, and the system has to answer
all of them: can it keep running, can it keep being maintained, can it keep
being paid for, and can it survive the people who built it leaving.

---

## 1. Can it keep running?

The system is built so that every dependency can fail without taking the
service down. This is deliberate, and each fallback is verified.

| If this fails | What happens | Verified |
| --- | --- | --- |
| three.js failing to load | AR still runs, drawing the piece as a true-scale box instead of the model. Less likely than it was: three.js now ships with the deployment instead of being fetched from a CDN at run time. | Yes — the no-THREE path renders and places |
| WebXR / ARCore missing | Untracked camera preview with a scale-reference ruler, labelled as an estimate. | Yes |
| The camera is refused | Manual measurement fields, and the fit verdict still works. | Yes |
| The network, mid-session | Already-loaded pages keep working; the model is cached by the browser. | Partially — no offline cache yet (§5) |

There is no single point of failure that produces a blank page. The worst case
is a stale catalogue, which is a degraded service rather than an outage.

## 2. Can it keep being paid for?

Both platforms have free tiers that the pilot fits inside with room to spare.
**Verify these figures against the current pricing pages before the defence —
they are as published at the time of writing and providers change them.**

| Resource | Free-tier allowance | Pilot's expected use | Headroom |
| --- | --- | --- | --- |
| Vercel bandwidth | 100 GB / month (Hobby) | A page load is ~150 KB plus a ~1.4 MB model. 1 000 sessions ≈ 1.6 GB | ~60× |

There is no database, so Vercel's allowance is the only one that applies today.
Models ship with the deployment, which means they count against Vercel bandwidth
rather than a storage tier — and against the repository's size, which is the
real ceiling on how many products this arrangement can hold.

**The binding constraint is model size.** The practical ceiling without a
database is roughly what is comfortable to keep in git — a few dozen models —
after which a storage backend becomes necessary. See `docs/DATABASE-LATER.md`.

<details>
<summary>The figures that applied when a database was connected (kept for when one is again)</summary>

| Resource | Free-tier allowance | Expected use | Headroom |
| --- | --- | --- | --- |
| Supabase database | 500 MB | A product row is well under 1 KB. 10 000 products ≈ 10 MB | very large |
| Supabase storage | 1 GB | At 1.4 MB per model, ≈ 700 models | ~700 products |
| Supabase monthly active users | 50 000 | Shop owners only — tens | very large |
| Supabase egress | 5 GB / month | Models served from Storage; 1 000 model views ≈ 1.4 GB | ~3× |

The binding constraint there was model storage and egress, not the database: a
practical ceiling of roughly 700 products and a few thousand model views a
month. Beyond that the first bill arrives — which is what the subscription tiers
in `docs/BUSINESS-PLAN.md` are sized to cover.
</details>

**Cost control levers, cheapest first:**

1. Compress models (Draco/meshopt typically cut a `.glb` by 70–90%). The
   armchair at 1.4 MB could be ~200 KB. This matters more now, not less: models
   ship with the deployment.
2. Cache aggressively — models never change in place, and `next.config.mjs`
   already serves `/models/*` as immutable for a year.
3. Remove products that are no longer stocked, and delete their files with them.
4. Only then, pay for a larger tier.

## 3. Can it keep being maintained?

- **Four runtime dependencies**, all mainstream: Next.js, React, React DOM and
  three.js. This is a real change from the first version of this document,
  which argued the app had none and therefore nothing to rot. That argument is
  gone and should not be claimed: a framework has to be kept current, and a
  major version will eventually need migrating.

  What was bought with it: furniture has shareable, indexable URLs, which is
  what lets a shop be found at all; pages render on the server instead of
  after a round trip on a phone connection; and three.js is pinned in
  `package-lock.json` rather than fetched from a CDN that has to be up when a
  customer opens the app. On balance the trade was worth making — but it is a
  trade, not a free win.
- **The AR engine is still plain JavaScript.** The largest and most delicate
  part of the codebase was moved into the framework, not rewritten in it, so it
  can be read and fixed without knowing React. See `docs/FRAMEWORK.md`.
- **59 automated tests** cover the API, the database access rules, the
  measurement mathematics and the data mapping, plus two browser checks
  (`npm run check:planner`, `npm run check:portal`) for the parts that only
  fail at runtime. A change that breaks an access rule or a formula fails
  before it ships.
- **The design system is documented** in `BRAND.md` with measured contrast
  ratios, so a later contributor can extend the interface without guessing.
- **The schema is a migration file**, not a hand-made database. A new
  environment is one migration run away.

## 4. Can it survive the team leaving?

This is where student projects usually die. The handover checklist in
`docs/MAINTENANCE.md` §7 is the mitigation: accounts transferred, secrets
rotated, addresses replaced, demo credentials removed.

The repository is the system of record. Everything needed to rebuild the
service from nothing — schema, seed data, deployment steps, brand, maintenance
protocol — is committed alongside the code, not in a chat thread or someone's
laptop.

**Data durability.** With no database, git is the backup: the catalogue, the
models and the schema are all committed, so any clone is a complete copy. That
is the one genuine advantage of the current arrangement.

When a database is reconnected this stops being true, and a backup routine
becomes necessary again — a free tier typically has no point-in-time recovery,
so a monthly dump kept off the platform is the minimum. A catalogue is cheap to
re-enter; a year of a store's uploaded models is not.

## 5. What is not sustainable yet

Stated plainly, because a sustainability claim with no gaps is not credible:

1. **No offline support.** A shopper with a weak connection in a store gets
   nothing. A service worker caching the shell and the catalogue would fix it
   and is the single highest-value addition left.
2. **No automated backups.** Manual, monthly, by a person who remembers.
3. **No error monitoring.** A runtime error on a shopper's phone is invisible
   to the team. The console logs are useful only to whoever is holding the
   phone.
4. **No CI.** The tests exist and pass, but nothing forces them to run before a
   merge. A GitHub Action running `npm test` on every push would close this.
5. **Models are made by the team, not the stores.** This does not scale past
   the pilot. Either the stores learn to produce `.glb` files, or photogrammetry
   from phone photos becomes part of the onboarding service — which is a cost
   line in the business plan, not a technical detail.
6. **One region.** Everything is hosted in Singapore. Fine for Mindoro;
   latency would need thought for a national rollout.

Items 1, 4 and 5 are the ones that decide whether this outlives the thesis.
