# FurnishAR

Browser-native furniture planning for Mamburao retailers. It includes a searchable catalog, responsive product previews, an Android WebXR placement entry point with a camera/screen fallback, two-point space measurement, clearance checks, and a role-scoped owner inventory portal.

## Start locally

Use Node.js 20 or newer, then run:

```powershell
npm.cmd run local
```

Open [http://localhost:4173](http://localhost:4173). `localhost` is treated as a secure context by Chrome, so it is suitable for testing camera/WebXR features. For a phone, deploy via HTTPS; WebXR will not start on a plain HTTP IP address.

## Demo owner accounts

| Store | Email | Password |
| --- | --- | --- |
| S&C Variety Store | `owner@furnishar.ph` | `furnishar` |
| Tiampion Buildings | `tiampion@furnishar.ph` | `furnishar` |
| Sanros General Merchandise | `sanros@furnishar.ph` | `furnishar` |

Catalog changes are written to `data/catalog.json`. Set `FURNISHAR_JWT_SECRET` to a strong unique secret before deployment, replace demo accounts with hashed credentials in a real identity provider, and move the JSON catalog to PostgreSQL/MySQL or equivalent managed storage.

## Panel feedback & roadmap

The thesis panel requested four features, all now implemented:

| Reviewer | Request | Implementation | Status |
| --- | --- | --- | --- |
| Leonard Flores (RECO) | Subscription tiers | Added `plan` tier per store (freemium: 8-product cap; premium: unlimited). Freemium stores cannot exceed the limit; premium stores can set `featured` on products which sort first in the catalog. | ✅ Done |
| Ian F. Bautista (Panel) | Maintenance audit trail | All products stamped with `updatedAt` (ISO timestamp) on create/edit. Owner dashboard shows "last updated" per row in relative time (e.g., "3 days ago"). | ✅ Done |
| Ian F. Bautista (Panel) | Measurement validation | Native AR measurement now requires a confirmatory scan. If readings differ by >5%, the UI shows a warning and asks to rescan. If within 5%, readings are averaged and accepted. Camera fallback and manual fields remain unchanged. | ✅ Done |
| Vina A. Atienza (Panel) | Store profiles | Each store now has address, contact number, and hours. Store info block appears in product detail dialogs. Addresses are currently placeholders (Mamburao, Occidental Mindoro) — **replace before public launch**. | ✅ Done |

## AR notes

The **Place in your room** action checks for WebXR immersive AR with hit-test support and requests a session only after the user chooses it. Android Chrome + ARCore is the pilot target. Browsers without that capability receive an accessible visual fallback and manual measurement controls, so they can still assess product fit.

## Deploying on Vercel

This project now exposes the API through `api/index.js`, a Vercel serverless-function handler. Vercel serves `index.html`, `styles.css`, and `client.js` from the `dist` output and rewrites all `/api/*` requests to that handler. The function configuration explicitly bundles the seed catalog. `local.js` is excluded from deployments and only starts the local development server.

In **Vercel → Project → Settings → Environment Variables**, set `FURNISHAR_JWT_SECRET` to a long random value, then redeploy. The bundled JSON catalog is read-only on Vercel, so catalog viewing and login work there, while product changes intentionally return a clear service message until the catalog is migrated to a persistent database or Vercel KV. Local development retains file-backed CRUD.
