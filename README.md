# TripMatch

A shared rides board for the Haas community — post a trip, see who else is going your way, skip the group-chat scroll.

**Live app:** https://tripmatch-app.github.io/

## What it does

Anyone with a Berkeley account can post a trip — offering seats or looking for a ride — with a route, date, and time. The board groups posts by route and date, and once several dates are active a row of date chips lets you jump straight to one day instead of scrolling. Nothing to install: open the link, sign in with the Google account behind your bMail, and you're on the board.

## Features

- **Berkeley-only sign-in** — Google Sign-In restricted to the `berkeley.edu` Workspace domain, verified server-side, so everyone on the board is a verified member of the community
- **Post a trip** — role (driving / need a ride), origin and destination city, date, optional time and notes
- **Grouped, filterable board** — routes grouped by region + date, with one-click filters for role and date
- **Comments** — ask a question on someone's post without leaving the page
- **Take a seat / +1** — on a driver's post, claiming a seat is capped at the seats offered: the badge counts down, and a full car shows as Full. On a rider's post it stays an uncapped "+1", since several people wanting the same trip is useful signal to a driver
- **Bring someone along** — a claim can cover more than one traveller, for family or friends without a Berkeley email. Seats remaining is the sum of party sizes, and the roster shows "Bob Rivera +1" so a driver can tell three claims from four passengers
- **Edit or delete your own post** — matched to your verified account, so it works from any device, with a two-step confirm before anything is deleted
- **Automatic expiry** — a post disappears from the board once its trip date has passed
- **Activity log** — every post, edit, delete, comment, +1 and sign-in is recorded with who and when, readable at `logs.html` by admins
- **Feedback inbox** — the in-app "issues or suggestions" form writes to the same backend, and a Feedback tab on `logs.html` shows each report in full, filterable by kind, with a mailto link back to the sender
- **Failure banner** — if TripMatch can't reach its backend, the page says so plainly instead of looking like an empty board

## How it's built

Still a static front-end with no build step — `index.html` and `logs.html` on GitHub Pages — but the data now lives behind a small API instead of in the browser's hands.

```
GitHub Pages (index.html)  →  Cloudflare Worker  →  D1 (SQLite)
        ↕
Google Identity Services (berkeley.edu only)
```

The Worker holds every credential, verifies the Google ID token against Google's public keys, enforces the `berkeley.edu` domain, and performs all writes as targeted SQL statements — so two people posting at the same moment can't overwrite each other. The browser never holds a secret and never writes directly.

This replaced a JSONBin setup that shipped an API key in the page source and rewrote the whole board as one JSON blob on every action. [INFRASTRUCTURE.md](INFRASTRUCTURE.md) explains what would have broken and when, why CalNet SSO proper isn't achievable without UC Berkeley IT, and what to watch as usage grows. Product requirements and open questions are in [tripmatch_prd_1.md](tripmatch_prd_1.md).

## Repository layout

| Path | What it is |
|---|---|
| `index.html` | The board — the whole front-end |
| `logs.html` | Admin activity-log viewer |
| `worker/worker.js` | The API |
| `worker/schema.sql` | Database schema |
| `worker/test/api.test.mjs` | 70 checks against the real worker and real SQL |
| `scripts/migrate-jsonbin-to-d1.mjs` | One-shot import from the old board |
| `DEPLOY.md` | Step-by-step deploy runbook |
| `INFRASTRUCTURE.md` | Architecture, scalability analysis, known limits |

## Running it locally

See [DEPLOY.md](DEPLOY.md#running-it-locally). In short: `npx wrangler dev` in `worker/`, serve the repo root statically, and point `API_BASE` at the local Worker.

To run the test suite — no network or Cloudflare account needed:

```bash
cd worker/test && node api.test.mjs
```

## Found a bug, or something's missing?

Email **eason_han@berkeley.edu** — bug reports and feature requests both welcome. There's also a link in the app's header for exactly this.
