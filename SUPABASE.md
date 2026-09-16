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

It picks automatically: supply a project URL and a publishable key (§4) and it
uses Supabase; leave either unset and it behaves exactly as it does today. If
the keys are set but the backend cannot be reached, it logs a warning and falls
back to the bundled catalogue rather than showing an empty shop.

**Already have `.env.local` from the dashboard? It works as-is — but rename two
variables so the key stops being published to the browser. See §4.**

---

## 0. Ignore the dashboard's framework snippets

Supabase's "Connect" panel hands out **Next.js** code by default:
`@supabase/ssr`, `createServerClient`, `cookies()` from `next/headers`,
`utils/supabase/server.ts`, `NEXT_PUBLIC_*` variables and a `todos` table.

**Most of it still does not apply**, even though this is a Next.js app now. The
integration already exists and is arranged so the key never reaches a browser,
which the dashboard's snippets explicitly do not do — their `client.ts` calls
`createBrowserClient` with `NEXT_PUBLIC_*` values, i.e. it publishes your key to
every visitor. And `todos` is not a table in this schema.

| The dashboard shows | This project uses |
| --- | --- |
| `@supabase/ssr`, `createServerClient` | `lib/supabase-proxy.js`, called from Route Handlers |
| `utils/supabase/server.ts`, `client.ts`, `middleware.ts` | two files: `lib/supabase-proxy.js` (server) and `public/supabase.js` (browser) |
| `cookies()` from `next/headers` | the browser's own session storage, in `public/supabase.js` |
| `process.env.NEXT_PUBLIC_*` inlined into the browser bundle | server-only variables, read by `lib/supabase-proxy.js`; the browser gets nothing |
| `createBrowserClient` calling Supabase from the page | the page calling `/api/sb/…` on this app's own origin |
| `supabase.from('todos')` | `supabase.from('catalog')` — see §"Schema at a glance" |

You do **not** need to create any `utils/` files, install any npm packages, or
add `@supabase/ssr`. The integration already exists. All you have to supply is
the URL and the key.

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
  `public.products` and `public.product_assets`. Realtime needs a websocket
  straight to your project, which the proxy (§4) deliberately does not open, so
  today the catalogue refreshes on a 60-second poll instead. Enabling
  replication costs nothing and keeps the option open.

## 4. Point the app at it

Two values, from **Settings → API**:

| Value | Where it comes from |
| --- | --- |
| Project URL | Settings → API → Project URL, e.g. `https://xxxxxxxx.supabase.co` |
| Publishable key | Settings → API keys → the **publishable** (`sb_publishable_…`) or legacy **anon** key |

### Name them without `NEXT_PUBLIC_`

This is the part that matters. **The prefix is not cosmetic** — anywhere it is
honoured, including Next.js, `NEXT_PUBLIC_` means *"copy this value into the
JavaScript sent to every visitor"*. Drop it, and the value stays on the server:

```bash
# .env.local — git-ignored
SUPABASE_URL=https://xxxxxxxx.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxxxxxxxxxxxxxxxxxxx
```

With these names the app runs in **proxy mode**: the browser calls this app's
own `/api/sb/…` routes, and `lib/supabase-proxy.js` calls Supabase with the key.
The page never receives the key — or even the project URL. You can confirm it
yourself: open DevTools → Network, and every Supabase request goes to your own
domain.

The proxy holds the *publishable* key on purpose, never the secret one, so row
level security still applies to every request. A signed-in browser forwards its
own access token, so the database sees the real user.

The old `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
names are still read, so an existing `.env.local` keeps working — but they are
now only ever read **on the server**, like the un-prefixed ones. Nothing writes
a key into the browser bundle any more: the build step that used to do that
(`build.js` and `dist/config.js`) was removed with the vanilla site, so there is
no configuration that can publish the key by accident. Prefer the un-prefixed
names anyway; the prefix means the opposite of what happens here and will
mislead the next person reading your Vercel settings.

The one thing this costs is Supabase realtime, which needs a websocket straight
to the project and cannot be proxied. The catalogue polls every 60 seconds
instead. For a pilot this size that is the better trade.

Then check the wiring before you deploy anything:

```bash
npm run check:supabase
```

It reports, one line at a time, whether the key is accepted, whether the tables
exist, whether the seed data is there, whether drafts are correctly hidden from
the public, whether the sign-up queue is closed, and whether email sign-in is
on. Every failure names the fix. Run it from a normal internet connection.

Then `npm run dev` and open [http://localhost:3000](http://localhost:3000).

### On Vercel

**Settings → Environment Variables** → add `SUPABASE_URL` and
`SUPABASE_PUBLISHABLE_KEY`, then redeploy. Vercel's own variables always win
over any `.env.local` left in a checkout. If you previously set the
`NEXT_PUBLIC_` versions there, rename them: they still work, but the prefix
tells every future reader that the value is published to the browser, which is
exactly what this setup is arranged not to do.

One more variable belongs here, and the app refuses to start on Vercel without
it:

```bash
FURNISHAR_JWT_SECRET=<a long random string>
```

It signs the owner session cookies for the demo accounts in `lib/handler.js`.
Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
Without it the code would fall back to a secret that is published in this
repository, and anyone could forge an owner session — so it throws instead.

> The **secret** (`sb_secret_…`) or **service_role** key must never go in any of
> these variables, not even the server-only ones. It bypasses row level security
> entirely, which would make the proxy the only thing standing between the public
> and every row in your database. `npm run check:supabase` refuses to run if it sees one.

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
