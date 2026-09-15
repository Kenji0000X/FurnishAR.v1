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
| The Supabase project | The app serves the catalogue bundled with the deployment. Browsing and AR still work; only owner edits stop. | Yes — with keys set but the library unreachable |
| The three.js CDN | AR still runs, drawing the piece as a true-scale box instead of the model. | Yes — the no-THREE path renders and places |
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
| Supabase database | 500 MB | A product row is well under 1 KB. 10 000 products ≈ 10 MB | very large |
| Supabase storage | 1 GB | At 1.4 MB per model, ≈ 700 models | ~700 products |
| Supabase monthly active users | 50 000 | Shop owners only — tens | very large |
| Supabase egress | 5 GB / month | Models served from Storage; 1 000 model views ≈ 1.4 GB | ~3× |

**The binding constraint is model storage and egress, not the database.** The
practical ceiling on the free tier is roughly 700 products and a few thousand
model views a month. Beyond that, the first bill arrives — which is exactly
what the subscription tiers in `docs/BUSINESS-PLAN.md` are sized to cover.

**Cost control levers, cheapest first:**

1. Compress models before upload (Draco/meshopt typically cut a `.glb` by
   70–90%). The armchair at 1.4 MB could be ~200 KB.
2. Cache aggressively — models are immutable once uploaded; `cacheControl` is
   already set to an hour and could be far longer.
3. Archive products instead of deleting, and delete their files.
4. Only then, pay for a larger tier.

## 3. Can it keep being maintained?

- **The app has no runtime npm dependencies.** Nothing to install, nothing that
  rots on the server. Two libraries load from a CDN at pinned versions, each
  with a fallback.
- **It is plain HTML, CSS and JavaScript** with no build framework. `npm run
  build` copies files and writes one config file. A student who can read
  JavaScript can maintain it; there is no toolchain to relearn in two years.
- **50 automated tests** cover the API, the database access rules, the
  measurement mathematics and the data mapping. A change that breaks an
  access rule or a formula fails before it ships.
- **The design system is documented** in `BRAND.md` with measured contrast
  ratios, so a later contributor can extend the interface without guessing.
- **The schema is a migration file**, not a hand-made database. A new
  environment is one `supabase db push` away.

## 4. Can it survive the team leaving?

This is where student projects usually die. The handover checklist in
`docs/MAINTENANCE.md` §7 is the mitigation: accounts transferred, secrets
rotated, addresses replaced, demo credentials removed.

The repository is the system of record. Everything needed to rebuild the
service from nothing — schema, seed data, deployment steps, brand, maintenance
protocol — is committed alongside the code, not in a chat thread or someone's
laptop.

**Data durability.** Supabase's free tier does not include point-in-time
recovery. Until the project is on a paid plan, take a manual backup at least
monthly and before any schema change:

```bash
supabase db dump -f backup-$(date +%F).sql     # schema + data
```

Keep the last three, off the platform. A catalogue is cheap to re-enter; a year
of a store's uploaded models is not.

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
