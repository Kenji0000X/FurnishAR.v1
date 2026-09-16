# The database, when you want it back

FurnishAR runs entirely on files right now. There is no database, no external
service, no API key, and nothing to configure. The Supabase integration was
removed on request.

## What the app does today

| | |
| --- | --- |
| Catalogue | `data/catalog.json`, committed to the repo |
| Shops | the three pilot shops in `lib/catalog.mjs` |
| 3D models | files in `public/models/` |
| Owner sign-in | the demo accounts in `lib/handler.js` |
| Adding furniture | works locally; read-only on Vercel |
| Store sign-ups | closed — the portal says so and gives an email address |

The one real limit: **Vercel's filesystem is read-only**, so an owner cannot
add or edit furniture on the deployed site. The API answers those with a clear
message instead of pretending to save. Editing the catalogue means editing
`data/catalog.json` and pushing. That is the thing a database fixes.

## What was kept

- `supabase/migrations/0001_init.sql` — the schema: stores, products, assets,
  applications, the row-level-security policies, the freemium cap trigger.
- `supabase/seed.sql` — the pilot shops and the armchair.
- `tests/db.test.js` — 14 tests proving those access rules actually hold,
  against a real Postgres. They skip when no Postgres is running, so
  `npm test` passes without one. Run them with `npm run test:db`.

None of that is wired into the app. It is design work worth keeping, and it is
what makes reconnecting a day's work rather than a rewrite.

## What was removed

The connection itself: the server-side proxy, the `/api/sb/*` routes, the
browser client, the credential loading, the connection checker, and the
`@supabase/supabase-js` dependency. The app has four dependencies now — Next,
React, React DOM and three.js — and no environment variables except
`FURNISHAR_JWT_SECRET`.

All of it is in git history, on the commit that removed it.

## Reconnecting later

The app talks to its data through three functions in `lib/catalog.mjs`:

```js
getCatalog()          // { products, source }
getProduct(idOrSlug)  // one product, or null
getStores()           // public shop details, keyed by slug
```

Every page is written against those and nothing else. Reimplementing them
against a database — Supabase or otherwise — is the whole read path. Then:

1. Run `supabase/migrations/0001_init.sql` and `supabase/seed.sql`.
2. Reimplement the three functions above.
3. Restore the owner portal's writes in `app/portal/backend.js`.
4. Put the credentials in **server-only** environment variables — no
   `NEXT_PUBLIC_` prefix, which means "send this to every visitor" — and have
   the browser reach them through a route handler rather than directly.

That last point is the one to keep from the previous attempt: a key in the
browser is a key anyone can read, and no framework changes that. Only a server
does.

## Before reconnecting anything

Two keys were committed to this repository and pushed to GitHub, so they are
public and must be treated as compromised. **Rotate them in the Supabase
dashboard before using that project again**, or start a fresh project. A
secret / service_role key bypasses row-level security entirely — every policy
in the migration above stops applying to whoever holds it.
