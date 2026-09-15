# FurnishAR on Supabase

The app runs two ways:

| | Without Supabase | With Supabase |
| --- | --- | --- |
| Catalogue | bundled `data/catalog.json` | `public.catalog`, live |
| Sign-in | the demo accounts in `lib/handler.js` | real Supabase Auth accounts |
| Sign-up | a note saying we'll be in touch | creates an account **and** a store application |
| Adding furniture | local only; read-only on Vercel | any approved owner, from their phone |
| 3D models | files committed to `public/models/` | uploaded to Storage, per store |
| Updates | on refresh | pushed live to every open browser |

It picks automatically: set `SUPABASE_URL` and `SUPABASE_ANON_KEY` and it uses
Supabase; leave either unset and it behaves exactly as it does today. If the
keys are set but the client library cannot be fetched, it logs a warning and
falls back to the bundled catalogue rather than showing an empty shop.

---

## 1. Create the project

1. <https://supabase.com/dashboard> → **New project**. Pick the Singapore
   region — it is the closest to Mamburao.
2. Save the database password somewhere safe; you will not be shown it again.

## 2. Create the schema

**SQL Editor** → paste `supabase/migrations/0001_init.sql` → **Run**. Then do
the same with `supabase/seed.sql`, which creates the three pilot shops and the
Cane Back Armchair.

With the CLI instead:

```bash
supabase link --project-ref <your-project-ref>
supabase db push
psql "$DATABASE_URL" -f supabase/seed.sql
```

The migration also creates the `furniture-models` storage bucket and its
policies. Confirm it under **Storage** — it should be public, 50 MB limit.

## 3. Turn on the parts the app expects

- **Authentication → Providers → Email**: enabled. For the pilot, turn
  *Confirm email* off so owners can sign in immediately; leave it on for
  production and they will get a confirmation link first. The app handles both.
- **Authentication → URL Configuration**: add your Vercel domain to *Site URL*
  and *Redirect URLs*.
- **Database → Replication** (or **Realtime**): enable replication for
  `public.products` and `public.product_assets`. This is what makes a shopper's
  catalogue update the moment a shop publishes something.

## 4. Point the app at it

**Vercel → Project → Settings → Environment Variables**:

| Name | Value | Where to find it |
| --- | --- | --- |
| `SUPABASE_URL` | `https://<ref>.supabase.co` | Settings → API → Project URL |
| `SUPABASE_ANON_KEY` | the `anon` / publishable key | Settings → API → Project API keys |

Redeploy. `npm run build` writes those into `dist/config.js`.

> The **anon key belongs in the browser** — that is its purpose, and row level
> security is what actually protects the data. The **service role key must
> never** be put in these variables or anywhere else the browser can read. The
> build refuses to run if `SUPABASE_ANON_KEY` looks like a service role key.

For local development, edit `public/config.js` directly. Do not commit real
keys to it.

## 5. Approve the first owner

Owners sign themselves up in the portal. That creates an auth account and a row
in `store_applications`, but the account owns nothing until you link it — until
then the portal shows them a "your store is in review" screen.

To approve, in the SQL editor:

```sql
-- See the queue
select id, store_name, contact_email, contact_phone, created_at
from public.store_applications
where status = 'pending'
order by created_at;

-- Link the account to a store (creating the store first if it is new)
insert into public.store_members (store_id, user_id, role)
select s.id, u.id, 'owner'
from public.stores s, auth.users u
where s.slug = 'sc-variety' and u.email = 'owner@furnishar.ph'
on conflict do nothing;

-- Close the application
update public.store_applications
   set status = 'approved',
       reviewed_at = now(),
       approved_store_id = (select id from public.stores where slug = 'sc-variety')
 where contact_email = 'owner@furnishar.ph';
```

The owner refreshes and has their dashboard.

---

## How the data is separated

Every piece of furniture belongs to exactly one store, and that is enforced by
the database, not by the interface:

- `products.store_id` is required and points at `stores`.
- Row level security lets an owner read, insert, update and delete **only**
  rows whose `store_id` is a store they are a member of. Another shop's rows
  are invisible to them, not merely hidden by the UI.
- Shoppers (the `anon` role) see only `status = 'published'` rows from active
  stores, through the `public.catalog` view.
- Uploaded files live at `<store_id>/<product_id>/model.glb`. A storage policy
  checks the first folder against the uploader's memberships, and
  `product_assets` has a check constraint requiring the same, so a file cannot
  be filed under another shop even by a hand-written API call.
- Business rules live in the database too: the 8-product freemium cap and
  premium-only featuring are triggers, so they hold no matter which client
  writes.

`tests/db.test.js` asserts all of the above against a real Postgres. Run it
with a local server on port 55432, or point `FURNISHAR_TEST_PG` at one:

```bash
npm run test:db
```

It skips itself when no Postgres is reachable, so `npm test` still passes
without one.

## Schema at a glance

```
stores ─┬─< store_members >─ auth.users
        └─< products ─< product_assets        (the uploaded .glb / .usdz)

store_applications                            (the public sign-up form)
catalog  (view: published products of active stores, with model paths)
```

| Table | What it holds |
| --- | --- |
| `stores` | One row per shop: name, address, hours, plan, active/suspended. |
| `store_members` | Which auth users may act for which store. A shop can have several owners. |
| `products` | Furniture. Real dimensions in cm, AR bounds, draft/published/archived. |
| `product_assets` | One row per uploaded file, keyed by product and kind (`glb`, `usdz`, `poster`). |
| `store_applications` | Sign-up submissions. Anyone may insert; only `service_role` may read or decide. |

## Moving the existing catalogue over

The three shops and the armchair are in `seed.sql`. The armchair's `.glb` is
still the copy committed at `public/models/cane-back-armchair.glb`; to move it
into Storage, sign in as the S&C owner, edit the product, and choose the file
in **3D model (.glb)**. That writes it to
`<store_id>/<product_id>/model.glb` and inserts the `product_assets` row, and
the catalogue starts serving it from Supabase.

## Costs and limits

The free tier covers this pilot: 500 MB database, 1 GB storage, 50 000 monthly
active users. A 1.4 MB model like the armchair means roughly 700 pieces before
storage becomes a question. The bucket caps uploads at 50 MB each.
