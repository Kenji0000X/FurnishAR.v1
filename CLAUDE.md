@AGENTS.md

# FurnishAR Development Rules

## Architecture Source of Truth

The primary system architecture reference is:

- `docs/FURNISHAR-DFD-V2.md`
- `docs/FURNISHAR-DFD-V2.drawio`

Before modifying authentication, authorization, product access, 3D model access, planner, store portal, admin functionality, or notification flows:

1. Read the DFD.
2. Inspect the existing implementation.
3. Compare implementation against the DFD.
4. Identify inconsistencies.
5. Preserve intended user flows.
6. Do not invent endpoints or processes.
7. Keep the DFD and implementation synchronized.

## Critical Architecture Rule

Authentication != Authorization.

Authentication determines who the user is.

Authorization determines whether the authenticated user can access a specific resource or perform a specific action.

Protected 3D assets must be authorization-checked server-side.

## Protected 3D Flow

Guest → Product → View 3D → Authentication Gate → Login/Signup → Restore Intended Destination → Planner → 3D Request → Authorization → Private 3D Asset → Signed Access → 3D Viewer

## DFD Files

`docs/FURNISHAR-DFD-V2.md` contains the textual architecture.

`docs/FURNISHAR-DFD-V2.drawio` contains the visual DFD.
