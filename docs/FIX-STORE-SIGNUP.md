# Fix Store Signup

The message below is expected in the current demo-only deployment:

> Online store applications are temporarily unavailable because the catalogue database is not connected.

It is shown by `app/portal/Portal.js`. The current `app/portal/backend.js` uses the local demo API, so signup does not create a Supabase account.

## 1. Create or confirm the Supabase project

In Supabase Dashboard:

1. Open the project used by FurnishAR.
2. Copy the current **Project URL** from **Settings -> API**.
3. Copy the current **Publishable key** or legacy **anon key**.
4. Run `supabase/migrations/0001_init.sql` in SQL Editor.
5. Run `supabase/seed.sql` if the initial catalogue is needed.
6. Under Authentication -> Providers, enable Email.
7. Add the Vercel domain under Authentication -> URL Configuration.

Use the current URL from the dashboard. If DNS cannot resolve the old `*.supabase.co` hostname, the project was deleted, renamed, or the URL is incorrect.

If signup logs say `Could not find the table public.store_applications in the
schema cache`, open Supabase **SQL Editor**, run the complete
`supabase/migrations/0001_init.sql` file from this repository, then run:

```sql
NOTIFY pgrst, 'reload schema';
```

Do the same if `store_members` returns `404`. Do not create only one table by
hand: the migration also installs the RLS policies, grants, catalogue view,
triggers, and storage policies required by the portal.

## 2. Configure local development

Keep the server variables in `.env.local`:

```env
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_your_key
FURNISHAR_JWT_SECRET=generate-a-new-random-value
```

Generate the JWT secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Do not use a `service_role` or `sb_secret_` key. Do not commit `.env.local`.

Check the connection:

```bash
npm run check:supabase
npm run dev
```

Then verify:

```text
http://localhost:3000/api/sb/status
http://localhost:3000/api/sb/status?probe=1
```

The first response must contain `"configured":true`. The probe must report `"reachable":true`.

## 3. Configure Vercel

In Vercel Project Settings -> Environment Variables, add these variables for **Preview** and **Production**:

```text
SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY
FURNISHAR_JWT_SECRET
```

Use the current Supabase values and a newly generated JWT secret. Redeploy after saving. `.env.local` is not uploaded to Vercel.

Also check Project Settings -> Deployment Protection. Disable protection for the public deployment or configure a public bypass. Protection redirects `/manifest.webmanifest` and API routes to `vercel.com/sso-api`, which causes the browser CORS error and prevents login.

## 4. Enable online signup in the app

Configuration alone does not remove the manual-email message. The portal must use the Supabase backend:

1. Restore or keep the Supabase client module used by the portal.
2. Make `initBackend()` call `/api/sb/status` and select Supabase when it returns `configured: true`.
3. Make `handleSignup()` call the Supabase signup method instead of always setting the manual-email message.
4. Insert the store application into `store_applications` after account creation.
5. Keep the manual-email message only as the fallback when the status check reports that Supabase is unavailable.

After changing the portal, run:

```bash
npm run build
npm test
```

## What each symptom means

| Symptom | Cause | Fix |
| --- | --- | --- |
| Manual store-email message | Demo backend or disconnected Supabase | Connect Supabase and restore the signup branch |
| `FURNISHAR_JWT_SECRET` error | Vercel/local secret is missing | Add the variable and redeploy |
| Login `502` | Supabase URL cannot be reached | Replace the URL with the current project URL and verify DNS |
| Manifest CORS / `vercel.com/sso-api` | Vercel Deployment Protection | Disable protection or add a public bypass |
| `/api/sb/status` returns `configured:false` | Supabase variables are absent or malformed | Add `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` |
