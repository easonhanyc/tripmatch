# TripMatch — Deploy Runbook

Everything needed to take TripMatch from the current JSONBin prototype to the
authenticated, logged, launch-ready setup. Budget **45–60 minutes**.

Nothing here is destructive to the live board until step 7, and step 7 is a
one-line revert if anything looks wrong.

**What you need:** a Google account (for the OAuth client), a Cloudflare
account (free), and Node 18+ locally.

---

## Step 0 — Export the board, then revoke the leaked key *(5 minutes)*

The master key `$2a$10$LAmSUbxwq…` sits in `index.html` in this repository's
git history. Every visitor to the live site has been able to read it, and a
master key is account-wide, not scoped to this one bin.

It has to be revoked — but the export in step 5 needs it, so do them in this
order and get both out of the way now:

**a. Export the current board** (this only reads; the live board is untouched):

```bash
node scripts/migrate-jsonbin-to-d1.mjs \
  --bin 6a8a4416f5f4af5e2936f5b2 \
  --key 'YOUR_JSONBIN_MASTER_KEY' \
  > worker/seed.sql
```

The key is the `JSONBIN_KEY` value in `index.html` before this change —
`git show HEAD:index.html | grep JSONBIN_KEY`. Check that `worker/seed.sql`
contains your posts before continuing.

**b. Revoke it:** sign in to [jsonbin.io](https://jsonbin.io) → **API Keys** →
regenerate/revoke the master key.

Don't skip (b) because the app no longer uses the key. It is public, and it
grants access to your whole JSONBin account.

---

## Step 1 — Google OAuth client *(10 minutes)*

1. Open the [Google Cloud Console](https://console.cloud.google.com/) → create
   a project, e.g. **TripMatch**
2. **APIs & Services → OAuth consent screen**
   - User type: **External**
   - App name `TripMatch`, your email as support + developer contact
   - Scopes: the defaults (`email`, `profile`, `openid`) — nothing more
   - Publishing status: **Publish app**. Left in "Testing" you'd be capped at
     100 named test users, which does not cover 400 students.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   - Type: **Web application**
   - Name: `TripMatch web`
   - **Authorized JavaScript origins** — both of these:
     - `https://tripmatch-app.github.io`
     - `http://localhost:8788` *(remove after testing)*
   - Leave redirect URIs empty — Google Identity Services doesn't use them
4. Copy the **Client ID** (ends `.apps.googleusercontent.com`)

> The client ID is public and appears in `index.html`. That's expected — it
> names the app, it doesn't authorize anything. There is no client *secret*
> in this design.

---

## Step 2 — Cloudflare account and D1 database *(10 minutes)*

```bash
cd worker
npm install
npx wrangler login
```

Create the database:

```bash
npx wrangler d1 create tripmatch
```

It prints a `database_id`. Put it in `worker/wrangler.toml`, replacing
`REPLACE_WITH_YOUR_D1_DATABASE_ID`, and set `GOOGLE_CLIENT_ID` in the same
file to the client ID from step 1.

Create the tables:

```bash
npx wrangler d1 execute tripmatch --remote --file=./schema.sql
```

---

## Step 3 — Secrets *(5 minutes)*

Generate a session-signing key:

```bash
openssl rand -base64 48
```

```bash
npx wrangler secret put SESSION_SECRET
```

Paste the generated value when prompted.

```bash
npx wrangler secret put ADMIN_EMAILS
```

Enter `eason_han@berkeley.edu` (comma-separate to add more). These accounts
are the only ones that can open the activity log.

> Secrets go through `wrangler secret`, never into `wrangler.toml` — that file
> is committed to git.

---

## Step 4 — Deploy the Worker *(2 minutes)*

```bash
npx wrangler deploy
```

It prints your URL, e.g. `https://tripmatch-api.your-subdomain.workers.dev`.

Check it:

```bash
curl https://tripmatch-api.your-subdomain.workers.dev/api/health
```

Expect `{"ok":true,"today":"2026-08-27"}`. If you get `ok:false`, the D1
binding is wrong — recheck `database_id` in `wrangler.toml`.

---

## Step 5 — Import the existing board *(3 minutes)*

Apply the `worker/seed.sql` you exported in step 0, so launch day doesn't
start empty and nobody loses a trip they already posted.

Read the file first — it's plain INSERT statements. Then:

```bash
cd worker
npx wrangler d1 execute tripmatch --remote --file=./seed.sql
```

The old JSONBin board is untouched by any of this and still works as a
fallback until you cut over in step 7.

**About imported posts:** they carry no email, because the old board never
collected one. Ownership falls back to a case-insensitive name match, so the
original posters keep their Edit and Delete. The first time one of them edits,
their verified email is written in and the fallback stops applying to that
post. Anyone who posted under a different name than their Google display name
will need to repost — worth a line in your launch message.

---

## Step 6 — Point the front-end at the Worker *(3 minutes)*

In **`index.html`**, near the top of the script:

```js
var API_BASE = "https://tripmatch-api.your-subdomain.workers.dev";
var GOOGLE_CLIENT_ID = "1234567890-abc….apps.googleusercontent.com";
```

In **`logs.html`**, set the matching `API_BASE`.

Confirm `ALLOWED_ORIGINS` in `wrangler.toml` includes your Pages origin, then
redeploy the Worker if you changed it:

```bash
cd worker && npx wrangler deploy
```

---

## Step 7 — Ship it

```bash
git add -A
git commit -m "Add Berkeley SSO, audit logging, and a D1 backend"
git push
```

GitHub Pages redeploys in a minute or two.

**Rollback**, if something is wrong: `git revert HEAD && git push`. The old
JSONBin board is untouched and comes straight back.

---

## Step 8 — Verify on the live site *(10 minutes)*

Walk it in a private window, in this order:

- [ ] Opening the site shows the **sign-in gate**, not the board
- [ ] A **personal Gmail** account is rejected with a clear message
- [ ] Your **@berkeley.edu** account signs in and the board appears
- [ ] Migrated posts are visible, grouped by route and date
- [ ] **Post a trip** — it appears, attributed to your real name
- [ ] Your own post shows **Edit** and **Delete**; +1 is disabled on it
- [ ] Sign in **on your phone** with the same account → your post still shows
      Edit/Delete *(this is the cross-device fix; worth confirming)*
- [ ] From a second account: **+1** and a **comment** both work, and that
      account sees no Edit/Delete on your post
- [ ] **Edit** the seat count and confirm comments survive
- [ ] **Delete** with the two-step confirm
- [ ] `logs.html` opens for your admin account and shows every action above
- [ ] `logs.html` is **refused** for a non-admin account
- [ ] Turn on airplane mode and tap +1 → the **offline banner** appears
- [ ] Turn it off → the banner clears on its own

Then clean up: remove `http://localhost:8788` from the Google OAuth origins
and from `ALLOWED_ORIGINS`, and redeploy.

---

## Running it locally

```bash
cd worker
npx wrangler d1 execute tripmatch --local --file=./schema.sql
npx wrangler dev
```

Serve the front-end separately (`npx serve .` from the repo root) with
`API_BASE` pointed at `http://localhost:8787`, and add both to
`ALLOWED_ORIGINS` and the Google OAuth origins while testing.

## Running the tests

```bash
cd worker/test && node api.test.mjs
```

70 checks against the real worker code, real SQL, and real RSA signature
verification — no network and no Cloudflare account needed. Run it before any
deploy.

---

## Operations

**Watch live traffic**

```bash
cd worker && npx wrangler tail
```

**Back up the database** — nothing does this automatically; worth a monthly
calendar reminder:

```bash
cd worker && npx wrangler d1 export tripmatch --remote --output backup-$(date +%F).sql
```

**Grant someone admin access to the log**

```bash
cd worker && npx wrangler secret put ADMIN_EMAILS
# re-enter the full comma-separated list
```

**Undo a delete.** Posts are soft-deleted, so a mistaken delete is
recoverable. Find the id in the activity log, then:

```bash
cd worker
npx wrangler d1 execute tripmatch --remote \
  --command "UPDATE posts SET deleted_at = NULL WHERE id = 'THE_POST_ID'"
```

**Invalidate every session** (the blunt instrument — everyone signs in again):

```bash
cd worker && npx wrangler secret put SESSION_SECRET   # enter a fresh value
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Gate says "Google sign-in didn't load" | GIS script blocked, or the client ID is still a placeholder | Check `GOOGLE_CLIENT_ID` in `index.html`; try another network |
| Sign-in returns 401 `BAD_CREDENTIAL` | `GOOGLE_CLIENT_ID` differs between `index.html` and `wrangler.toml` | Make them identical, redeploy the Worker |
| Every request 403 `FORBIDDEN_ORIGIN` | The site's origin isn't in `ALLOWED_ORIGINS` | Add the exact origin (scheme + host, no trailing slash), redeploy |
| Banner: "isn't connected to its backend yet" | `API_BASE` is still a placeholder | Set it in `index.html` and `logs.html` |
| `/api/health` returns `ok:false` | D1 binding wrong or schema not applied | Recheck `database_id`; re-run the schema command |
| Log page says "isn't a TripMatch admin" | Email missing from `ADMIN_EMAILS` | Re-put the secret with the full list |
| A user can't edit their pre-launch post | Their Google display name differs from the name they posted under | Ask them to repost, or reassign: `UPDATE posts SET author_email='them@berkeley.edu' WHERE id='…'` |
