# TripMatch

A shared rides board for the Haas community — post a trip, see who else is going your way, skip the group-chat scroll.

**Live app:** https://tripmatch-app.github.io/

## What it does

Anyone with the link can post a trip — offering seats or looking for a ride — with a route, date, and time. The board groups posts by route and date, and once several dates are active a row of date chips lets you jump straight to one day instead of scrolling. No accounts and nothing to install: open the link, type your name once, and it's remembered on that device for next time.

## Features

- **Post a trip** — name, role (driving / need a ride), origin and destination city, date, optional time and notes
- **Grouped, filterable board** — routes grouped by region + date, with one-click filters for role and date
- **Comments** — ask a question on someone's post without leaving the page
- **+1 a post** — fit an existing trip exactly? Count yourself in instead of posting a duplicate
- **Edit or delete your own post** — matched by the name you posted under, with a two-step confirm before anything is deleted
- **Automatic expiry** — a post disappears from the board once its trip date has passed

## How it's built

One static HTML file (`index.html`), no build step, hosted on GitHub Pages. The shared board lives in a single JSONBin.io JSON store, read and written directly from the browser. There's no login — identity is just a name remembered per device, and trust comes from the link only circulating inside the private Haas group chat. Full detail, requirements, and open product questions live in [tripmatch_prd_1.md](tripmatch_prd_1.md).

## Running it locally

It's one file — open `index.html` in a browser, or serve the folder with any static file server. The deployed instance already has a shared backend configured; to test against your own data, point `JSONBIN_BIN_ID` / `JSONBIN_KEY` near the top of `index.html` at your own free [JSONBin.io](https://jsonbin.io) bin.

## Found a bug, or something's missing?

Email **eason_han@berkeley.edu** — bug reports and feature requests both welcome. There's also a link in the app's header for exactly this.
