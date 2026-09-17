# Business plan — subscription model

*Addresses: Mr. Leonard Flores — "Startup idea: consider business plan.
Subscription: Freemium, Premium."*

The tiers are not a slide. They are enforced by the database: the 8-product cap
and premium-only featuring are triggers in
`supabase/migrations/0001_init.sql`, tested in `tests/db.test.js`. What this
document claims, the system already does.

---

## 1. Who pays, and why

FurnishAR is two-sided, but only one side pays. **Shoppers never pay** — they
are the reason a store wants to be listed. **Stores pay** because the product
removes a specific, expensive problem: a customer who travels to the shop,
likes a cabinet, buys it, and returns it because it does not fit the space. For
a Mamburao retailer, one avoided return covers months of subscription.

| | Shopper | Store owner |
| --- | --- | --- |
| Pays | Never | Freemium or Premium |
| Gets | True-scale AR, room measurement, fit verdict | Listings, 3D models, shoppers who already know it fits |

## 2. The tiers

| | **Freemium** | **Premium** |
| --- | --- | --- |
| Price | Free | ₱499 / store / month |
| Products | Up to 8 published | Unlimited |
| AR placement and measurement | Yes | Yes |
| 3D model upload (100 MB/file) | Yes | Yes |
| Store profile on every listing | Yes | Yes |
| Featured placement at the top of the catalogue | — | Yes |

**Why 8 products free.** Enough for a small store to prove the tool sells
furniture, too few for a full catalogue. The store hits the ceiling exactly
when the product has started working for them — the moment at which paying is
an easy decision rather than a leap of faith.

**Why ₱499.** Roughly the price of one small delivery, and far below the cost
of a single returned cabinet. It is a number a barangay retailer can approve
without a meeting. It should be tested against three real store owners before
it is fixed; the figure is an assumption, not a finding.

## 3. Unit economics

Per store, per month, on the pilot's infrastructure (see
`docs/SUSTAINABILITY.md` for where these allowances come from):

| Item | Cost |
| --- | --- |
| Hosting and database, per store, at pilot scale | ~₱0 — inside the free tiers |
| Model storage, ~20 models @ 1.4 MB | ~28 MB of a 1 GB allowance |
| **Marginal cost of one more freemium store** | effectively zero |
| **Marginal cost of one more premium store** | effectively zero until the tiers are exceeded |

The real cost is not infrastructure — it is **making the 3D models**. At the
pilot, the team produces them. That is the line item that decides whether this
is a business:

| Onboarding a store | Effort |
| --- | --- |
| Account, profile, first listings | ~1 hour |
| 3D model per product (photogrammetry or modelled) | 1–3 hours each |

**This is the constraint the plan lives or dies on.** Three paths, in order of
attractiveness:

1. **Stores supply their own models.** Many suppliers already have them from
   manufacturers. Cheapest, and already supported — the upload field exists.
2. **Charge for modelling as a one-off service** (e.g. ₱300–500 per piece).
   Turns the constraint into revenue and self-limits demand.
3. **Phone photogrammetry during onboarding.** Highest effort to build, best
   long-run margin.

## 4. Break-even

Fixed monthly costs at pilot scale are near zero, so break-even is not about
covering servers — it is about covering the team's time. If onboarding and
modelling for one store costs roughly 6 hours of work, a store must stay
subscribed long enough to repay that. At ₱499/month, that is several months per
store, which makes **retention, not acquisition, the number to watch**.

Realistic first-year target for Mamburao: **3 pilot stores free → 10 stores, of
which 3–4 premium.** That is ~₱1,500–2,000/month: not a salary, but enough to
prove the model converts and to fund the hosting past the free tier.

## 5. Risks, honestly

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| **Model production does not scale** | The one real cost; see §3 | Push path 1, price path 2 |
| **Android-only AR** | iPhone shoppers get a preview, not tracked AR | Add `.usdz` for iOS Quick Look — the field already exists |
| **Too few shoppers to matter to stores** | A store pays for reach it can feel | Keep the pilot dense: one town, several stores, before expanding |
| **A free tier that is good enough** | 8 products may satisfy a small store forever | The cap is a business lever; it can be tuned with evidence |
| **Platform pricing changes** | Free tiers are not contracts | Costs are documented and the stack is portable — plain files plus Postgres |

## 6. What is a decision, and what is an assumption

**Decided and built:** two tiers; 8-product free cap; premium-only featuring;
stores pay, shoppers do not; enforcement in the database.

**Assumed, and needing evidence before the plan is defended:** the ₱499 price
point, the willingness to pay for modelling, the 10-store first-year target,
and the claim that avoided returns are what motivates a store owner. Each of
these is a question for three interviews, not a thing to state from a slide.
