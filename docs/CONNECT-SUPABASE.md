# Connecting Supabase to FurnishAR, step by step

Follow this once and the app stops serving the catalogue committed in the repo
and starts serving your database: real owner accounts, per-store furniture,
3D model uploads.

You need: a Supabase account, this repo checked out, Node 20+, and the Vercel
project. Budget about 30 minutes.

`SUPABASE.md` is the reference for *what each piece does*. This file is the
order to do it in.

---

## Step 0 — Rotate the leaked keys first

**Do this before anything else.** A secret key was committed to this repository
and pushed to GitHub in commit `605805c`, so it is public and must be treated as
compromised. A secret (`sb_secret_…` / `service_role`) key bypasses row level
security completely — whoever has it can read, change or delete every row and
every uploaded file, no matter what policies you write.

1. Supabase dashboard → **Settings → API keys**.
2. Roll the **secret** key. Roll the **publishable** key too, since it was in the
   same commit.
3. Use the new values everywhere below.

Deleting the file does not help: the commit stays in GitHub's history and in
every clone anyone has made.

---

## Step 1 — Create the project

1. <https://supabase.com/dashboard> → **New project**.
2. Region: **Singapore** — the closest to Mamburao, and the difference is
   noticeable on a phone connection.
3. Save the database password somewhere safe. You are not shown it again.

Wait for the project to finish provisioning before continuing.

---

## Step 2 — Create the tables

**SQL Editor → New query**, paste the whole of
`supabase/migrations/0001_init.sql`, **Run**.

Then a second query with `supabase/seed.sql`, **Run**. That creates the three
pilot shops and the Cane Back Armchair, so there is something to look at.

This also creates the `furniture-models` storage bucket. Check
**Storage** — you should see it, public, with a 50 MB limit.

<details>
<summary>With the Supabase CLI instead</summary>

```bash
supabase link --project-ref <your-project-ref>
supabase db push
psql "$DATABASE_URL" -f supabase/seed.sql
```
</details>

---

## Step 3 — Turn on email sign-in

**Authentication → Providers → Email**: enabled.

For the pilot, turn **Confirm email off** so an owner can sign in immediately.
Leave it on for real use and they get a confirmation link first — the app
handles both and says which one happened.

**Authentication → URL Configuration**: put your Vercel domain in *Site URL* and
*Redirect URLs*.

> If sign-ups fail later with "Sign-ups are turned off for this project", this
> is the step that was missed.

---

## Step 4 — Copy the two values

**Settings → API**:

| Value | Looks like |
| --- | --- |
| Project URL | `https://abcdefgh.supabase.co` |
| Publishable key | `sb_publishable_…` (or a legacy `anon` key) |

**Take the publishable key, never the secret one.** The app refuses the secret
key on purpose; see Step 0 for why.

---

## Step 5 — Put them in `.env.local`, without the `NEXT_PUBLIC_` prefix

Create `.env.local` in the project root:

```bash
SUPABASE_URL=https://abcdefgh.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_your_new_key
FURNISHAR_JWT_SECRET=paste-a-long-random-string-here
```

Generate the secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**The missing prefix is the point.** `NEXT_PUBLIC_` means, by definition, "copy
this value into the JavaScript sent to every visitor" — it is how the Supabase
dashboard's own quickstart publishes your key to anyone who opens DevTools.
Without the prefix the key stays on the server, and the browser reaches Supabase
through this app's own `/api/sb/…` routes instead.

The `NEXT_PUBLIC_*` spellings are still *accepted* so an existing file keeps
working, but rename them: the prefix tells every future reader the opposite of
what is happening.

`.env.local` is git-ignored. Do not commit it.

---

## Step 6 — Check the wiring before deploying

```bash
npm run check:supabase
```

It goes through, one line at a time: credentials found → the key is publishable
and not secret → the project is reachable → the key is accepted → the shops are
seeded → furniture is published → drafts are hidden from the public → the
sign-up queue is private → the storage bucket exists → email sign-in is on.

Every failure names the fix. Run it from a normal internet connection.

**Do not go further until this is all `ok`.** Every problem is cheaper to fix
here than after a deploy.

---

## Step 7 — Run it locally

```bash
npm run dev
```

Open <http://localhost:3000>. You should see the seeded furniture rather than
the bundled armchair.

Then sign in at <http://localhost:3000/portal> with an account you create in
Step 9, and confirm the dashboard opens.

---

## Step 8 — Set the same variables on Vercel

**Vercel → your project → Settings → Environment Variables.** Add all three:

| Name | Value |
| --- | --- |
| `SUPABASE_URL` | your project URL |
| `SUPABASE_PUBLISHABLE_KEY` | your **new** publishable key |
| `FURNISHAR_JWT_SECRET` | a long random string |

Then **redeploy** — environment variables only take effect on a new build.

Two things that catch people here:

- **Delete any `NEXT_PUBLIC_SUPABASE_*` variables** you set previously.
- `FURNISHAR_JWT_SECRET` is not optional in production. Without it the app
  refuses to start rather than sign owner sessions with a secret that is
  published in this repository and therefore forgeable.

**The first visitor after a deploy sees the bundled catalogue.** The build
machine has no database access, so the first render falls back to the committed
file; pages then refresh from Supabase on a 60-second cycle. Load the page,
wait a minute, load it again — that is expected, not a fault.

---

## Step 9 — Approve the first owner

An owner signs themselves up at `/portal`. That creates an account **and** a row
in `store_applications` — but the account owns nothing until you link it, so
until then they see a "your store is in review" screen. That is deliberate:
nobody gets to publish into your catalogue by signing up.

To approve, in the SQL editor:

```sql
-- 1. See who is waiting
select id, store_name, contact_email, contact_phone, created_at
  from public.store_applications
 where status = 'pending'
 order by created_at;

-- 2. Link the account to a store
insert into public.store_members (store_id, user_id, role)
select s.id, u.id, 'owner'
  from public.stores s, auth.users u
 where s.slug = 'sc-variety'              -- the store
   and u.email = 'owner@example.ph'       -- the account
on conflict do nothing;

-- 3. Close the application
update public.store_applications
   set status = 'approved',
       reviewed_at = now(),
       approved_store_id = (select id from public.stores where slug = 'sc-variety')
 where contact_email = 'owner@example.ph';
```

They refresh and have their dashboard.

---

## How to tell it worked

- The catalogue shows your database's furniture, not the Cane Back Armchair.
- An owner can sign in at `/portal` and see their own products only.
- Adding a product in the portal makes it appear in the catalogue within a
  minute.
- DevTools → Network: every Supabase request goes to **your own domain**
  (`/api/sb/…`). Search the page source for `sb_publishable` and find nothing.
  That last one is the check worth repeating after any change.

## When something fails

| What you see | What it means |
| --- | --- |
| Catalogue still shows the armchair | Variables missing or the deploy predates them. Check Vercel, then redeploy. |
| "This deployment has no Supabase backend configured" | The server cannot see `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY`. |
| "Sign-ups are turned off for this project" | Step 3. |
| "Too many attempts. Wait…" | Supabase rate-limits auth. Wait it out; the button counts down. Your account may already exist — try signing in. |
| "Account created… could not file your store application" | The account is real. Do **not** sign up again; the application needs adding by hand. |
| Owner signs in but sees "your store is in review" | Step 9 has not been done for them. |
| Anything else | Vercel → your project → **Logs**. Auth failures log the Supabase status and error code, never the password. |
