# TripMatch — Infrastructure

How TripMatch is put together after the launch hardening, why the previous
setup would not have survived the Haas cohort, and what to watch as it grows.

*Written August 26, 2026, the day before public launch.*

---

## The shape of it

```
┌────────────────────────┐        ┌──────────────────────────┐
│  GitHub Pages          │        │  Google Identity         │
│  (static, free)        │        │  Services                │
│                        │        │                          │
│  index.html            │──1────▶│  Sign in, hd=berkeley.edu│
│  logs.html             │◀───────│  → signed ID token       │
└────────┬───────────────┘        └──────────────────────────┘
         │
         │ 2. POST the ID token, get a TripMatch session
         │ 3. Bearer <session> on every request
         ▼
┌────────────────────────────────────────────────────────────┐
│  Cloudflare Worker  (tripmatch-api)                        │
│                                                            │
│   • verifies the Google token against Google's JWKS        │
│   • enforces the berkeley.edu domain                       │
│   • mints / verifies its own HMAC session token            │
│   • owns every write; the browser never writes directly    │
│   • appends an audit row per mutation                      │
│   • rate-limits per account                                │
│   • daily cron archives past-dated posts                   │
└────────┬───────────────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────────────────────┐
│  Cloudflare D1 (SQLite)                                    │
│  users · posts · comments · plus_ones · audit_log          │
└────────────────────────────────────────────────────────────┘
```

Everything above is on a free tier. There is no monthly bill at this scale.

**The rule that shapes the design:** the browser holds no secret and performs
no write. It holds a session token that proves who the user is; the Worker
decides what that person is allowed to do. Before this change the browser held
a key that could erase the entire board.

---

## What was wrong before

### 1. The API key was published to every visitor

`index.html` carried a JSONBin **master key** in plain source:

```js
var JSONBIN_KEY = "$2a$10$LAmSUbxwq…";   // visible in View Source
var JSONBIN_AUTH_HEADER = "X-Master-Key";
```

Anyone who opened the page could read it, and a master key is account-wide —
not scoped to this one bin. With it, any visitor could rewrite the board,
delete every post, or reach other bins on the same account. No exploit was
needed; the credential was simply handed out with the page.

The file's own comment acknowledged this and recommended a scoped Access Key
instead. That would have been an improvement, but not a fix: a scoped key is
still public, so any visitor could still wipe the board. Only a server can
hold a credential the browser doesn't see.

> **Action required regardless of anything else here: revoke that master key
> in the JSONBin dashboard.** It is in this repository's git history and must
> be treated as compromised. Rotating it is step 0 of the deploy runbook.

### 2. Concurrent writes silently lost posts

Every mutation followed the same pattern — read the entire board, change one
thing in memory, write the entire board back:

```js
var current = await loadPosts();   // read all
current.push(post);                // change one
await savePosts(current);          // write all
```

Two people acting inside the same round trip produced this:

| time | Alice | Bob | stored |
|------|-------|-----|--------|
| t0 | reads board (12 posts) | | 12 |
| t1 | | reads board (12 posts) | 12 |
| t2 | writes 13 (hers) | | 13 |
| t3 | | writes 13 (his) | **13 — Alice's post is gone** |

No error is raised. Alice sees her post appear (she rendered from her own
copy), then it quietly vanishes on her next refresh. The window is one HTTP
round trip — roughly 200–600 ms on mobile — and it applied to posting,
commenting, +1ing, and deleting alike.

This is not a rare race. Launch day means a WhatsApp link landing in front of
~400 students at once, which is exactly the burst that produces overlapping
writes. The same flaw also meant a **stale delete could resurrect posts**: a
tab open for ten minutes still held the old array, and any action from it
wrote that whole stale array back, restoring posts other people had deleted.

The fix is structural. Every mutation is now a single targeted statement —
`INSERT INTO comments …`, `DELETE FROM plus_ones WHERE post_id = ? AND
author_email = ?` — so concurrent writers touch different rows and cannot
overwrite each other. The regression test fires 12 simultaneous posts,
comments and +1s and asserts all 36 survive; against the old design they
would not have.

### 3. Ownership was a name typed into a box

Edit and Delete compared the post's name against a name in `localStorage`.
That meant, all at once: you lost control of your post when you switched from
laptop to phone; anyone could type your name and gain control of it; and the
audit trail was worthless, because the "who" was self-declared.

### 4. Failures were invisible

A failed request set an error string inside whichever form was open. If the
backend was down at page load, `loadPosts()` returned `[]` on error — so a
total outage rendered as **"Nothing posted yet"**, which reads as an empty
board. Users would respond by posting again into a backend that wasn't
accepting writes.

---

## Would JSONBin have broken? Yes — three ways, all before 200 posts

You asked specifically about ~400 students and a peak of ~200 live posts.

### Bin size — the wall you hit first

JSONBin's free tier caps a single bin at **100 KB**. The whole board is one
bin. Measured against the actual record shape:

| Posts | No engagement | 2 comments + 2 +1s each | 4 comments + 3 +1s each |
|------:|--------------:|------------------------:|------------------------:|
| 100 | 33 KB | 76 KB | **113 KB** ✗ |
| 150 | 49 KB | **113 KB** ✗ | **170 KB** ✗ |
| 200 | 66 KB | **151 KB** ✗ | **226 KB** ✗ |

A board of bare posts fits. A board people actually *use* does not. At the
engagement levels the current design encourages — comments and +1s are two of
the three features added after user testing — **the cap is reached somewhere
between 100 and 150 posts, roughly half your expected peak.**

The failure mode is ugly: the write is rejected, and because the client wrote
the whole array every time, *every* subsequent write fails too. The board
freezes for everyone at once. Paid tiers raise the cap to 1 MB, which buys
time but not a different shape — it's still one document, rewritten in full,
by every user, for every action.

### Request quota

The free tier allows on the order of **10,000 requests/month**, and the old
client spent them carelessly — every mutation cost two (a read then a write),
and the opportunistic expiry sweep added another.

A conservative week for 400 students:

| Activity | Requests |
|---|---:|
| 400 students × 3 board opens | 1,200 |
| 200 posts × 2 | 400 |
| 400 comments × 2 | 800 |
| 400 +1s × 2 | 800 |
| expiry sweeps | ~100 |
| **weekly** | **~3,300** |
| **monthly** | **~13,200** |

That is over the free quota inside the first month, and it assumes each
student opens the board only three times a week — implausibly low for a tool
meant to replace scrolling a group chat.

### Concurrency

Covered above: no compare-and-swap, no row-level writes, no way to make the
read-modify-write cycle safe from a browser. This one has no tier to upgrade
to. It is a property of storing a shared mutable list as a single JSON
document that every client rewrites.

**Conclusion:** JSONBin was a good choice for a prototype and a bad one for a
launch. All three limits bite well inside your stated numbers.

---

## Why Cloudflare Workers + D1

Weighed against Supabase, Firebase, and a small VPS:

| | Workers + D1 | Supabase | Firebase | VPS |
|---|---|---|---|---|
| Cost at this scale | $0 | $0 | $0 | ~$5–12/mo |
| Ops burden | none | none | none | patching, uptime, TLS |
| Sleeps when idle | no | **yes, after ~1 week** | no | no |
| Row-level writes | yes | yes | yes | yes |
| Server-side secrets | yes | yes | yes | yes |
| Build step | none | none | none | varies |
| Lock-in | SQL, portable | Postgres | proprietary | none |

Workers + D1 won on three points that matter here. It keeps the project's
"one file, no build step" character — the Worker is a single `worker.js` you
deploy with one command. It doesn't idle out, so a board that goes quiet over
winter break still answers instantly in January. And the data is ordinary
SQLite: if you ever outgrow it, `wrangler d1 export` gives you a `.sql` file
that restores into Postgres or anything else.

### Headroom against the free tier

| Limit | Free allowance | Expected peak | Headroom |
|---|---|---|---|
| Worker requests | 100,000/day | ~3,000/day | 33× |
| D1 rows written | 100,000/day | ~2,000/day | 50× |
| D1 storage | 5 GB | < 5 MB | 1000× |
| D1 rows read | 5,000,000/day | ~1,200,000/day | **4×** |

Three of these are not worth thinking about. The fourth is worth naming
honestly: **row reads are the tightest constraint.** Each board load reads
every live post plus its comments and +1s — roughly 600 rows at peak — so
2,000 board loads a day lands near 1.2 M. Comfortable, but it's 4× headroom
rather than 30×, and it's the number that would move if usage doubled.

If it ever gets close, the fix is small and doesn't change the architecture:
cache the assembled board JSON in Workers KV for 10–15 seconds and serve
repeat loads from it. At 400 students the same board is being fetched over and
over within seconds of itself, so even a very short cache would cut row reads
by an order of magnitude. **Not needed at launch — this is the thing to
implement if `wrangler d1 insights` shows reads climbing past ~3 M/day.**

---

## Identity: why not literal CalNet

You asked for CalNet. Here is the honest position.

Real CalNet SSO is Shibboleth/SAML (with a CAS endpoint alongside). Using it
requires UC Berkeley IT to register TripMatch as an approved **Service
Provider** — an application, a review, a security questionnaire, and a
production-hosted SP with a metadata endpoint and certificate management.
That is a multi-week process at best, and a static GitHub Pages site cannot be
an SP at all. Your own PRD already recorded this as a v1 non-goal for exactly
these reasons.

What ships instead is **Google Sign-In restricted to the `berkeley.edu`
Workspace domain**. Berkeley's bMail runs on Google Workspace, so every CalNet
holder already has a `@berkeley.edu` Google account, and Google's own login
sits behind CalNet-managed credentials. The Worker verifies the ID token's
RSA signature against Google's published keys, then checks issuer, audience,
expiry, `email_verified`, and the `hd` (hosted domain) claim.

**What this gives you that a typed name did not:**

- A verified, unforgeable `@berkeley.edu` address per user
- Ownership that follows the person, not the browser — the laptop/phone
  problem in the PRD's open questions is solved
- An audit log where "who" is evidence rather than a claim
- A closed community: a `gmail.com` account is rejected at the door

**What it does not give you:**

- It proves *Berkeley*, not *Haas*. Any berkeley.edu account can sign in.
  Given the link circulates in the Haas group chat this is a small gap, and
  `ALLOWED_HD` plus an allow-list of emails could tighten it if it ever
  matters.
- It is not CalNet, so it won't satisfy a requirement that says "CalNet"
  literally — e.g. if this ever becomes an official campus service.
- It depends on Google. If `accounts.google.com` is unreachable on a user's
  network, they cannot sign in; the gate detects this and says so explicitly
  rather than showing an empty box.

**Migrating to real CalNet later** does not require a data migration. Identity
is keyed on the `@berkeley.edu` email address, and CalNet's Shibboleth
assertion carries that same address as `mail`. Swapping the token-verification
function in `handleAuthSession` is the whole change; every existing post,
comment, and log row keeps working. If you decide to pursue it, the request
goes to UC Berkeley IST's Identity and Access Management group.

---

## The audit log

Every mutation appends one row to `audit_log`, in the same request that
performs it, recording: timestamp, actor email, actor name, action, entity
type and id, an action-specific JSON detail, plus IP, country, and user agent.

Actions recorded: `login`, `login.rejected`, `post.create`, `post.update`,
`post.delete`, `post.update.denied`, `post.delete.denied`, `comment.create`,
`plusone.add`, `plusone.remove`, `post.expire`, `rate_limited`, `logs.denied`,
`migration.import`.

Three deliberate choices:

- **`post.update` records a field-level diff** (`seats: 2 → 4`), not the whole
  row. Whole-row snapshots are unreadable when you're trying to answer "who
  changed this, and to what?"
- **Denied attempts are logged too.** A log of only successful actions cannot
  show you someone trying to delete other people's posts.
- **Logging never fails a request.** `logEvent` swallows its own errors: a
  dropped log line is a smaller problem than a lost trip post.

Posts are **soft-deleted** (`deleted_at` is set, the row stays), so a log
entry always points at something real and a mistaken delete is one `UPDATE`
away from being undone.

Read it at `logs.html`, restricted to the emails in the `ADMIN_EMAILS` secret
and enforced server-side — not by hiding the link. It filters by action,
actor, and time range, and exports CSV straight from the API rather than from
what's on screen, so an export is the authoritative record.

**Retention:** nothing prunes `audit_log` today. At this volume it will take
years to matter. If you'd rather it not accumulate indefinitely, add a delete
of rows older than a year to the existing daily cron.

---

## Failure handling

One banner, above the board, in four states:

| State | Trigger | What it says | Action |
|---|---|---|---|
| `unconfigured` | `API_BASE` still a placeholder | Deployment isn't wired up | — |
| `offline` | `navigator.onLine === false` | You're offline; the board may be stale | auto-clears |
| `unreachable` | `fetch` rejected | It's us, not you; posting is paused | Retry |
| `server` | HTTP 5xx | Nothing was saved | Retry |
| `rateLimited` | HTTP 429 | Paused about a minute | — |
| `expired` | HTTP 401 mid-session | Sign in again to post | Sign in |

Principles behind it, each one a response to how the old build failed:

- **Transport failures go to the banner; action failures stay inline.** "You
  can only edit your own posts" belongs next to the button you pressed, not
  in a page-level notice.
- **An empty board and an unreachable board never look alike.** If no load has
  succeeded, the board says "Couldn't load the board — this isn't an empty
  board, it's a board we couldn't reach."
- **A stale session at boot goes to the sign-in gate**, not to a banner
  hovering over a board we never loaded.
- **The connection dot in the header** stays amber or red after a failure, so
  the state survives even once the banner is gone.
- **Recovery is automatic** where it can be: the app re-fetches on `online`
  and when a backgrounded tab is brought forward.

---

## Known limits and what to watch

**Sessions cannot be revoked.** Session tokens are stateless and signed; there
is no server-side session list to invalidate. A token stays valid for 14 days.
Rotating `SESSION_SECRET` invalidates every session at once, which is the
blunt instrument if you ever need one. A `sessions` table would fix it
properly; it isn't worth the round trip at this size.

**Rate limiting is per account, and approximate.** It counts that account's
recent `audit_log` rows — 20 writes/minute. It stops accidental floods and
casual abuse, not a determined attacker with many berkeley.edu accounts.

**The token lives in `localStorage`, not an HttpOnly cookie.** The front-end
and API are on different origins, so a cookie would be third-party and
therefore blocked by Safari and increasingly by Chrome. `localStorage` is the
right trade here, and it means an XSS bug would expose sessions — which is why
every user-supplied string is escaped at render. Putting both behind one
custom domain would allow a cookie later.

**The board is fetched, not pushed.** No websockets: you see new posts on
load, on tab focus, and after your own actions. Right for a board people check
a few times a day; if it ever needs to be live, Durable Objects are the path.

**`hd` is checked but the account picker's `hd` hint is only a hint.** A user
can still submit a personal account; the Worker rejects it. Client-side hints
are convenience, never a control.

### What to check after launch day

```bash
cd worker
npx wrangler tail                      # live request log
npx wrangler d1 insights tripmatch     # query volume and slow queries
```

- **Row reads** — the one number with only 4× headroom. Add the KV cache if
  it approaches 3 M/day.
- **`login.rejected` entries** — a cluster of `wrong_domain` means people are
  arriving with personal Google accounts and may need telling.
- **`rate_limited` entries** — if honest users hit it, raise
  `RATE_LIMIT_MAX_WRITES`.
- **`post.update.denied` / `post.delete.denied`** — a burst suggests the
  legacy-post ownership fallback is confusing someone.

---

## If Cloudflare is ever the wrong answer

The data is plain SQLite and the API is ~800 lines of standard JavaScript with
no Cloudflare-specific dependencies beyond the D1 binding and `request.cf`.

```bash
npx wrangler d1 export tripmatch --remote --output backup.sql
```

That file restores into Postgres, SQLite, or anything that speaks SQL. Do this
periodically anyway — **there is no automated backup configured**, and one
line in the deploy runbook covers it.
