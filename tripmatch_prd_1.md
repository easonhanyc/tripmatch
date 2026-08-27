# TripMatch — Product Requirements Document
*(working title — carpool coordination for the Haas community)*

**Author:** Eason Han
**Status:** v2.0 — launch hardening complete
**Last updated:** August 26, 2026

---

## Problem Statement

Haas students regularly need ad hoc rides — day trips and treks into SF, weekend getaways to and from the South Bay, Sunday returns to campus — but today this is coordinated entirely through word of mouth and scrolling the class WhatsApp chat. Requests get buried under unrelated messages, there's no way to see who else is going the same way at the same time, and finding a match requires either getting lucky with timing or posting redundant "does anyone have a car" messages. This wastes seats on trips that already have room, and it wastes students' money and time on solo rideshares or long transit connections when a matching classmate exists.

This isn't a new problem to solve from scratch — general-purpose carpool apps (Waze Carpool, various campus carpool startups) have tried and mostly failed or stayed niche, largely because they had to build trust and liquidity among strangers. The Haas cohort already has both: shared trust and naturally clustered travel patterns around specific events (treks, class events, weekend commutes). The gap isn't "no carpool tool exists" — it's "no one has built the version that fits a small, trusted, high-overlap community" instead of a stranger marketplace.

---

## Post-Launch Update — External User Feedback (Aug 25, 2026)

V1 shipped and got its first round of real external usage from the Haas cohort. Three gaps surfaced immediately once real posts started accumulating on the shared board:

1. **No way to remove a post.** A rider whose plans fell through, or a driver whose seats filled up off-platform, had no way to take their post down — stale entries just sat on the board until they aged out at midnight on the trip date. *(Shipped just before this round, in [5619f93](https://github.com/tripmatch-app/tripmatch-app.github.io/commit/5619f933fa7b1b59fb9d0d18404fbfd1064bbcf9): a Delete button appears only on posts matching the viewer's remembered name, and requires a second "Yes, delete" tap before it actually removes the post.)*
2. **No way to correct a post.** If a detail changed — a later pickup time, one more open seat, a different notes line — the only fix was deleting the post and re-posting from scratch, losing any comments already on it. **Added this round:** an Edit button next to Delete, scoped to the same owner check, that reopens the post form pre-filled and updates the existing entry (including its custom "other city" values) in place, preserving its comment thread and posted-at time.
3. **The board doesn't scale with volume.** The original design grouped posts by route + date and just listed every group top to bottom — fine for a handful of posts, but as the board fills up across several trip dates, finding "just Friday's trips" means scrolling past everything else. **Added this round:** a horizontal row of date chips above the board (e.g. "Tue, Aug 25 · 3", "Fri, Aug 28 · 1") that let a viewer jump straight to one day's trips. It only appears once the board actually spans more than one date — with a single date it would be redundant with "All dates" — and it composes with the existing offering/looking-for-a-ride filter rather than replacing it.

All three were validated locally against an isolated mock backend (multiple test personas posting, editing, filtering by date, and deleting) before shipping, so the shared production board was never touched during testing.

---

## Launch Hardening — Infrastructure (Aug 26, 2026)

Prototype feedback drove the three product gaps above. Preparing for public
launch surfaced a different class of problem: the v1 storage design would not
have survived the cohort it was built for. Four things shipped this round.

### 1. Verified identity replaces the typed name

**The constraint, stated plainly:** true CalNet SSO (Shibboleth/SAML) requires
UC Berkeley IT to register TripMatch as an approved Service Provider — an
application, a review, and a server-side SP that a static GitHub Pages site
cannot be. The non-goal below recorded this correctly and it still holds.

**What shipped instead:** Google Sign-In restricted to the `berkeley.edu`
Workspace domain. Berkeley's bMail runs on Google Workspace, so every CalNet
holder already has one, and the ID token is verified server-side against
Google's published keys — issuer, audience, expiry, `email_verified`, and the
`hd` domain claim. A personal Gmail account is rejected at the door.

This closes the two open questions the PRD had been carrying:

- *"Remembered identity is scoped to a single device/browser."* — **Resolved.**
  Identity now follows the person. Posting from a laptop and editing from a
  phone works.
- *"Ownership is still just a name match, not a login."* — **Resolved.**
  Ownership is an email match against a verified account. Nobody can claim
  someone else's post by typing their name, and there's no way to be locked
  out of your own by a spelling difference.

Posts that predate launch have no email attached; they fall back to the old
name match so their authors keep control, and the first edit stamps the
verified email in permanently.

### 2. Activity log

Every mutation — and every *denied* mutation — appends a row recording who,
what, when, and what changed. Admins read it at `logs.html`, filterable by
action, actor, and date, exportable as CSV. Posts are soft-deleted, so a
mistaken delete is recoverable rather than gone.

### 3. Honest failure states

v1 failed silently: a dead backend rendered as **"Nothing posted yet"**, which
reads as an empty board and invites a duplicate post. There is now one banner
above the board covering offline, unreachable, server error, rate limited, and
expired session — each with the action that might fix it, and the empty board
now distinguishes "nothing here" from "couldn't ask".

### 5. Joining a driver's trip became a capped seat claim (Aug 26, later)

"+1" was ambiguous on a driver's post — it read as either "I want a seat" or
"I'm also driving that way" — and nothing enforced capacity, so six people
could +1 a car with three seats. Joining is now role-dependent: a capped
**seat claim** on driver posts (with a counting-down badge and a Full state),
and an uncapped **+1** on rider posts, where multiple interested riders is
signal rather than a conflict.

The cap is enforced inside the INSERT, so two people tapping the last seat at
the same instant cannot both get in — verified by a test that fires ten
simultaneous claims at a one-seat car and asserts exactly one wins.

### 4. Storage rebuilt on Cloudflare Workers + D1

The v1 JSONBin design had three defects that all bite inside the expected
usage (~400 students, ~200 concurrent posts):

| Defect | Consequence |
|---|---|
| API key published in page source | Any visitor could wipe the entire board |
| Whole-board read-modify-write | Simultaneous posts silently overwrote each other |
| One 100 KB JSON document | Board freezes at roughly 100–150 posts with comments — about half the expected peak |

Every mutation is now a targeted SQL statement against a single row, all
credentials live server-side, and the free tier carries 30×+ headroom on every
dimension but one (row reads, at 4×, with a documented mitigation). Full
analysis in [INFRASTRUCTURE.md](INFRASTRUCTURE.md).

Verified by 70 automated checks against the real worker code and real SQL —
including a concurrency test that fires 36 simultaneous writes and asserts all
of them survive, which the v1 design would have failed.

---

## Goals

1. Give students a faster way to find a matching ride than scrolling WhatsApp — target: a user can post or find a match in under 2 minutes.
2. Surface unmet demand and unclaimed supply automatically, rather than requiring students to keep re-asking in chat.
3. Achieve real, organic weekly usage within the Haas cohort during the build's active testing window (no baseline exists today since coordination is informal).
4. Demonstrate that structured categorization (route + date) meaningfully outperforms unstructured chat search for finding a match.

---

## Non-Goals

- **Not a payments or cost-splitting tool.** Venmo/cash stays off-platform — out of scope for v1, adds trust/liability complexity not worth solving here.
- **Not a real-time dispatch or booking system.** This is not Uber — it connects people who then coordinate logistics themselves.
- **Not a replacement for WhatsApp.** Final coordination (exact pickup point, contact exchange) happens off-platform; the tool's only job is surfacing the match.
- **No open/public matching in v1.** Restricted to the Haas community — opening to strangers reintroduces the trust problem this design is specifically meant to avoid.
- **No formal identity verification (email login, magic link, or true campus SSO).** ~~True CalNet-style single sign-on would require UC Berkeley IT to register this as an approved service provider — not achievable for a v1 build. Trust instead comes from the distribution channel itself.~~ **Superseded at launch (Aug 26, 2026).** The CalNet constraint still holds and is unchanged, but the conclusion drawn from it no longer does: Google Sign-In scoped to the `berkeley.edu` Workspace domain delivers verified identity without IT involvement, and the v1 trust model turned out to be load-bearing for more than trust — ownership, the audit log, and cross-device editing all depended on it. See the Launch Hardening section above.
- **No native mobile app.** A mobile-friendly web link is the right form factor — zero install friction, one tap from a WhatsApp message.

---

## User Stories

- As a student without a car, I want to post my trip need (date, time, origin, destination) so that others going the same way can see it.
- As a student with a car, I want to indicate that I'm driving and how many seats I have so that others can find and join me.
- As a student browsing, I want to see requests and offers grouped by route and date so I can find a match without reading unrelated posts.
- As a student, I want to be notified if a match appears in my category after I've posted, so I don't have to keep checking back.
- As a returning user, I want the app to remember my name after my first post so that I don't have to retype it every time I use it.
- As a poster whose plans fell through, I want to remove my own post so the board doesn't show a trip that's no longer happening.
- As a poster whose details changed, I want to edit my own post in place so I don't have to delete and repost (losing any comments) just to fix a time or seat count.
- As a student browsing a board with many trip dates active at once, I want to jump straight to one date's trips so I don't have to scroll past everything else to find mine.
- As a student who fits an existing trip exactly, I want to +1 it so the poster sees interest without a redundant duplicate post cluttering the board.
- As a rider looking at a driver's post, I want to claim one of their seats and see how many are left, so I know whether there is actually room for me before I plan around it.
- As a driver, I want claiming to stop once my seats are gone, so I don't arrive to find more people expecting a lift than I can carry.

---

## Requirements

### Must-Have (P0)

| Requirement | Acceptance Criteria |
|---|---|
| Trip input form | Given a user opens the app, when they submit their name, date, time window, origin city, destination city, and role (driver/rider), then a new entry is created and categorized. |
| Name capture for contact | Given a user submits any post, when the form is completed, then their name is stored and displayed alongside their post so a match knows who to reach out to. |
| Remembered identity | Given a user has posted once from a device, when they return to post again, then their name is pre-filled and they are not asked to re-enter it. |
| Driver capacity capture | Given a user selects "I'm driving," when they submit the form, then they must also enter number of available seats. |
| City-to-region categorization | Given a new entry is submitted, when the user selects a specific city as origin or destination (e.g., Sunnyvale, Mountain View, Palo Alto), then the system maps that city to its broader region (e.g., South Bay) using a fixed lookup table, and buckets the entry into a category by region + date (e.g., "Outbound: Berkeley → South Bay, Fri 8/28"). |
| Grouped board view | Given entries exist, when a user views the board, then entries are displayed grouped by category and sorted by date/time, with drivers and riders visibly distinguished, and each entry shows the poster's name and specific city. |
| Shareable app link | Given the app is deployed, when accessed via a shared link, then it loads without requiring app installation. |
| Post expiration | Given a post's trip date has passed, when the system runs its daily cleanup check, then the post is automatically removed from the board. |
| Owner-only post deletion | Given a post exists, when the viewer's remembered name matches the post's poster name, then a Delete control is shown; deleting requires a second confirmation step before the post is removed from shared storage. |
| Owner-only post editing | Given a post exists and the viewer is its owner (by the same name match as deletion), then an Edit control is shown that reopens the post form pre-filled with the post's current values; saving updates the existing entry in place, preserving its comments and original post time. |
| Date-filter summary row | Given the board has posts spanning more than one trip date, when a viewer opens the board, then a row of date chips (each showing the date and its post count) appears above the grouped list, and selecting one narrows the board to that date; the row is hidden when only one date is present. |
| Seat claim (driver posts) | Given a driver's post with N seats and the viewer is not its owner, then a "Take a seat" control is shown and the badge reports seats remaining; claiming adds the viewer to the trip and decrements the count. When N seats are claimed the control becomes a disabled "Full" and further claims are refused server-side, including when two people claim the last seat simultaneously. A rider who has claimed a seat may release it, freeing it for someone else. |
| Interest counter, "+1" (rider posts) | Given a rider's post and the viewer is not its owner, then a "+1" control shows the running count of others going the same way; tapping it toggles the viewer on or off that list. Uncapped, since several riders wanting the same trip is signal to a driver rather than a conflict. |

### Nice-to-Have (P1)

| Requirement | Acceptance Criteria |
|---|---|
| Natural-language entry | Given a user types a free-text trip description, when submitted, then the system parses it into structured fields for confirmation before posting. |
| New-match notifications | Given a user has an active post, when a new matching entry is submitted to the same category, then the user receives a notification. |
| Automated WhatsApp push | Given a new post is submitted, when categorized, then a message is automatically sent to a designated WhatsApp group (requires WhatsApp Business API approval — may not land in v1 timeline). |

### Future Considerations (P2)

- Expansion to other Haas cohorts (EWMBA, other class years) or other Berkeley grad programs
- In-app contact/request-to-join flow instead of manual WhatsApp handoff
- Personalized suggestions based on a user's recurring travel patterns (e.g., "you usually go home Fridays — post automatically?")

---

## Success Metrics

**Leading indicators**
- Number of trip posts per week
- % of posts that receive at least one matching counterpart within 48 hours
- Median time from post to match
- % of new users who complete verification and post or browse within their first session

**Lagging indicators**
- Repeat usage rate (does a user who posted once come back to post again for their next trip)
- Qualitative preference signal (a short survey: do users prefer this over the WhatsApp chat, and why)

---

## Open Questions

- **What's the initial city-to-region lookup table, and who maintains it if a city is missing?** — needs a first-pass list (e.g., which cities count as "South Bay" vs. "Peninsula") before the categorization logic can be built. *(Product decision.)*
- ~~**"Remembered identity" is scoped to a single device/browser.**~~ **Resolved (Aug 26, 2026)** — identity is a verified Berkeley account, so it follows the person across devices.
- **Does removing an expired post also need to notify anyone who had a pending interest in it?** — minor, but worth a quick decision so users aren't left wondering why a post disappeared. *(Product/design.)*
- ~~**Ownership is still just a name match, not a login.**~~ **Resolved (Aug 26, 2026)** — ownership is an email match against a verified account, enforced server-side. Posts imported from the pre-auth board keep the name fallback until their author's first edit.

- **New: does Berkeley-wide access need narrowing to Haas?** The domain gate proves `berkeley.edu`, not Haas specifically. Given the link circulates in the Haas group chat this is likely fine, but an email allow-list could tighten it. *(Product decision — recommend watching the activity log for unexpected sign-ins before acting.)*
