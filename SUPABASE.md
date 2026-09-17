# FurnishAR on Supabase

> **Setting this up for the first time? Follow
> [docs/CONNECT-SUPABASE.md](docs/CONNECT-SUPABASE.md)** — the same material in
> the order you need to do it, with the checks between steps. This file is the
> reference for what each piece does and why.

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
policies. Confirm it under **Storage** — it should be public, 100 MB limit.

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

## 5. Make yourself the superadmin

There are two portals, and this is the one step that cannot be done in either.

| | who signs in | where | what they can do |
|---|---|---|---|
| Store portal | a store owner | `/portal` | their own shop: products, prices, stock, 3D models |
| Platform console | you | `/admin` | vet sign-ups, approve or reject them, see every store and every decision |

An owner is admin of their own shop and nothing else. A platform admin never
becomes a member of anyone's store — they can read the roster and the queue,
and approve, but they cannot publish furniture as somebody else.

Being a platform admin means having a row in `public.platform_admins`. There is
deliberately **no insert policy on that table**, so nobody can promote
themselves, or be tricked into promoting someone, through the app — not even an
existing admin. The only way in is database credentials. Run this once in the
SQL editor, with your own email:

```sql
insert into public.platform_admins (user_id, note)
select id, 'founder' from auth.users where email = 'you@example.com'
on conflict (user_id) do nothing;
```

(Sign up at `/portal` first if you have no account yet — the row needs a user to
point at.) Sign in, and the portal grows a **Platform console** link.

Removing an admin is the same table:

```sql
delete from public.platform_admins
where user_id = (select id from auth.users where email = 'them@example.com');
```

It takes effect on their very next click; nothing is cached.

### Approving a store owner

Owners sign themselves up in the portal. That creates an auth account and a row
in `store_applications`, but the account owns nothing yet — until it is
approved, the portal shows them a "your store is in review" screen.

The way in is the **Superadmin sign-in** link at the bottom of the store
sign-in page — the only entry point, and the same for you as for anyone who
clicks it out of curiosity. They get "not available to this account"; you get
the console.

Open `/admin`. Each application shows the store name, contact email, phone and
what they intend to list — check those against the business before approving,
which is the point of the queue.

Two of those checks are made for you, because they can be. The console shows
whether the address belongs to a real account, whether that account has
confirmed it owns the address, and when they last signed in; and
`approve_store_application` refuses outright if the address is unconfirmed or
the account is disabled. So an applicant who typed somebody else's email cannot
be approved, however convincing the form looked. The judgement left to you is
the part a database cannot make: is this a real furniture shop in Mamburao.

Set the address their shop will live at, then approve. That one action creates the store, links their account to it as owner,
closes the application and records the decision under your email in
`admin_audit`, all in a single transaction — if any part fails, none of it
happens.

Rejecting requires a note, which is kept on the record.

The audit table is append-only by design: there is no insert or delete policy,
so entries can only be written by the approve/reject functions and cannot be
forged or erased through the app.

### Watching the 3D files

Further down the console, **3D files** lists every model uploaded across every
store — the shop it belongs to, the product, the file size and when it landed —
including drafts, which a non-member would never be shown. Anything over 40 MB
is flagged: the storage bucket allows up to 100 MB, but a file that big will
take minutes on a phone in Mamburao, so 40 MB is a "look at this" line, not
the actual ceiling. Below it, any listing with no model attached is called
out, because those cannot be placed in AR at all. Below that, **Usage by
store** totals the bytes each shop has uploaded — see Costs and limits below
for why that number is worth watching now that a single file can be 100 MB.

This view is **read-only, deliberately**. `0004_admin_model_visibility.sql` adds
two SELECT policies and no write policy, so an operator can see a problem but
cannot edit or delete another shop's furniture — that stays the owner's job in
their own portal. Seeing everything and owning everything are different powers,
and only one of them is needed to run the platform.

### The seeded armchair has no model until you upload one

Worth knowing before it surprises you, because it looks exactly like a
regression and is not one.

Without Supabase the catalogue is `data/catalog.json`, where the Cane Back
Armchair's `modelGlb` is `models/cane-back-armchair.glb` — **a file bundled in
the app**, which always loads. Connect Supabase and the catalogue comes from
the database instead, and `supabase/seed.sql` creates that product but
deliberately creates no `product_assets` row for it (its own comment says the
.glb is uploaded through the owner portal). Storage starts empty; nothing puts
that bundled file into it.

So the armchair that worked before connecting the database stops having a model
after, along with every other seeded piece, and the planner correctly reports
"this piece has no 3D model uploaded yet". Nothing broke — the app changed
which source of truth it reads. Upload a .glb through the portal for each
seeded product and they work again.

That file, `public/models/cane-back-armchair.glb`, is about 1.4 MB and is a
useful thing to upload first when a bigger model is being refused: if it goes
through and a large one does not, the size limit is the whole problem and
nothing else is wrong with the pipeline.

### When a model will not show in AR

The planner used to answer every one of these with the same sentence — *"3D
preview unavailable on this device"* — which is a guess, and usually the wrong
one. It now names the cause, and each one has its own fix:

| What the planner says | What is actually wrong | What to do |
| --- | --- | --- |
| "This piece has no 3D model uploaded yet" | The product row exists; `product_assets` has no `glb` for it. Usually an upload that failed after the product was created. | Open the piece in the store portal and upload the model again. The console's **3D files** section lists every listing in this state. |
| "The model could not be downloaded (HTTP 4xx/5xx)" | Storage would not serve the file — missing object, private bucket, or a Storage error. | Check the object exists under **Storage → furniture-models**, and that the bucket is **public**. |
| "…the server sent a web page instead of a file" | Something returned HTML where the model should be — on Vercel this is usually **Deployment Protection** on a preview URL intercepting the request. | Either test on the production domain, or **Project Settings → Deployment Protection** and allow the preview. |
| "…the .glb looks corrupt or incomplete" | The bytes are not a readable glTF-binary. | Re-export from the 3D tool and upload again. |
| "This device cannot show the 3D preview — it has no WebGL2" | Genuinely the device. This is the only one that is. | Use the measurement fields, or a newer phone. |

Uploads are checked before they are stored, so most of the last case never gets
that far: `uploadModel()` reads the 12-byte glTF header and refuses a file whose
magic is not `glTF` or whose declared length does not match the file — a renamed
`.gltf`, a `.zip`, a half-finished download. Storage only checks the mime type
the browser claims, and nothing else in the chain looks inside the file.

**If you are locked out** — no admin account, or the console is unreachable —
the SQL editor still works:

```sql
select id, store_name, contact_email, contact_phone, created_at
from public.store_applications where status = 'pending' order by created_at;

select public.approve_store_application('<application-id>', 'their-shop-slug');
```

`approve_store_application` checks `is_platform_admin()`, so this path needs the
SQL editor's own credentials — it is not a way around the wall.

### What stops the wrong person

Three layers, and only the first one actually protects the data:

1. **Row level security.** Every policy is in
   `supabase/migrations/0003_platform_admin.sql` and
   `supabase/migrations/0004_admin_model_visibility.sql`, and
   `tests/admin.test.js` proves them by connecting *as* an anonymous visitor,
   two different store owners, an admin and a stranger, and trying things that
   should fail: reading the queue, approving an application, promoting oneself,
   forging or deleting an audit entry, reading another shop's draft listings,
   and — for the admin — writing to a shop they do not belong to.
2. **The server.** `lib/auth.js` refuses admin requests at the API boundary, so
   an anonymous request for the sign-up queue never reaches Postgres, and a
   non-admin gets a plain 403 instead of an empty list that reads like an empty
   queue. It re-checks identity with Supabase on every request and caches
   nothing. `tests/auth.test.js` covers it.
   `applicant_account` is security-definer too, because `auth.users` is
   readable by nobody and should stay that way: it answers for one application
   at a time, only for an admin, and returns only whether the account exists, is
   confirmed, is disabled, and when it last signed in.
3. **The interface.** `/admin` asks the server whether you are an admin and
   renders accordingly. This is the layer that protects nothing, which is why
   the other two exist. `npm run check:admin` drives a real browser to confirm
   a signed-in store owner reaching `/admin` is refused and shown no applicant's
   email or phone number.

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

`tests/db.test.js` asserts all of the above against a real Postgres, and
`tests/admin.test.js` does the same for the platform-admin wall. Run them with a
local server on port 55432, or point `FURNISHAR_TEST_PG` at one:

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

The free tier covers this pilot for a while: 500 MB database, **1 GB storage**,
50 000 monthly active users. A 1.4 MB model like the armchair means roughly
700 pieces before storage becomes a question — that was true at the old 50 MB
per-file cap and is still true today, because most real models will not be
anywhere near the ceiling.

The ceiling itself changed. `0005_raise_model_limit.sql` raises the bucket's
`file_size_limit` to **100 MB per file** — asked for so a store owner is not
turned away for a legitimately detailed model. What that changes is the worst
case, not the typical one: **one badly optimised upload can now be 100 MB
instead of 50**, and it is entirely possible for a handful of large files to
use up the free tier's 1 GB faster than 700 small ones ever would. Twenty
50 MB files is already the whole free allowance.

### The bucket limit is not the only ceiling

**A Free project cannot accept a file over 50 MB, whatever this bucket says.**
Supabase enforces a project-wide maximum in **Storage → Settings**, a per-bucket
`file_size_limit` cannot exceed it, and on the Free plan that maximum is 50 MB.
Running 0005 on a Free project therefore does **not** get you 100 MB uploads —
Storage still refuses at 50, with "The object exceeded the maximum allowed
size". Neither does 70 MB, or anything else above 50. The only ways past it are
to upgrade the plan (Pro raises the project maximum substantially) or to make
the file smaller.

Make the file smaller. It is the better answer anyway, and not a compromise:
this app is built for phones on mobile connections in Mamburao, and a 50 MB
model is a multi-minute download for **every shopper who opens it**, not just
once for the owner who uploaded it. Furniture models routinely come out of a 3D
tool at tens of megabytes and compress to single digits with no visible loss —
Draco or meshopt geometry compression, and textures resized to 1–2k. A 2 MB
model that loads is worth more than a 60 MB one nobody waits for.

This does not need watching constantly, but it does need watching:

- **Settings → Usage** in the Supabase dashboard shows the project's real
  storage total against the plan.
- The console's **Usage by store** table (`public.storage_usage()`, added by
  0005) shows the same total broken down per shop, from inside the app,
  without needing dashboard access.
- If the free tier's 1 GB stops being enough, the paid tier's storage is
  billed per GB beyond it — cheap at this scale, but not free, and worth
  deciding on deliberately rather than discovering by way of a failed upload.

Nothing about raising the per-file cap changes how fast the *app* runs.
Uploads go straight from the browser to Storage — never through this app's
own server or its database — so a 100 MB file does not load the app any more
than a 5 MB one does, and fifty owners uploading fifty models at once are
fifty independent uploads, not fifty requests competing for one server. The
only place the new limit shows up as slower is the browser doing the actual
upload, on whatever connection it has — which is real, and is why the portal
now shows upload progress as a percentage instead of a static "Uploading…",
so a slow upload reads as working rather than stuck.
