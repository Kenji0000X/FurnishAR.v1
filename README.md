# FurnishAR

Browser-native furniture planning for Mamburao retailers. It includes a searchable catalog, responsive product previews, an Android WebXR placement entry point with a camera/screen fallback, two-point space measurement, clearance checks, and a role-scoped owner inventory portal.

## Start locally

Use Node.js 20 or newer, then run:

```powershell
npm.cmd start
```

Open [http://localhost:4173](http://localhost:4173). `localhost` is treated as a secure context by Chrome, so it is suitable for testing camera/WebXR features. For a phone, deploy via HTTPS; WebXR will not start on a plain HTTP IP address.

## Demo owner accounts

| Store | Email | Password |
| --- | --- | --- |
| S&C Variety Store | `owner@furnishar.ph` | `furnishar` |
| Tiampion Buildings | `tiampion@furnishar.ph` | `furnishar` |
| Sanros General Merchandise | `sanros@furnishar.ph` | `furnishar` |

Catalog changes are written to `data/catalog.json`. Set `FURNISHAR_JWT_SECRET` to a strong unique secret before deployment, replace demo accounts with hashed credentials in a real identity provider, and move the JSON catalog to PostgreSQL/MySQL or equivalent managed storage.

## AR notes

The **Place in your room** action checks for WebXR immersive AR with hit-test support and requests a session only after the user chooses it. Android Chrome + ARCore is the pilot target. Browsers without that capability receive an accessible visual fallback and manual measurement controls, so they can still assess product fit.
