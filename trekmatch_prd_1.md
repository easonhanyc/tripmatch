# TrekMatch — Product Requirements Document
*(working title — carpool coordination for the Haas community)*

**Author:** [Your name]
**Status:** Draft v1.1 — updated with resolved open questions
**Last updated:** August 22, 2026

---

## Problem Statement

Haas students regularly need ad hoc rides — recruiting treks into SF, weekend trips to and from the South Bay, Sunday returns to campus — but today this is coordinated entirely through word of mouth and scrolling the class WhatsApp chat. Requests get buried under unrelated messages, there's no way to see who else is going the same way at the same time, and finding a match requires either getting lucky with timing or posting redundant "does anyone have a car" messages. This wastes seats on trips that already have room, and it wastes students' money and time on solo rideshares or long transit connections when a matching classmate exists.

This isn't a new problem to solve from scratch — general-purpose carpool apps (Waze Carpool, various campus carpool startups) have tried and mostly failed or stayed niche, largely because they had to build trust and liquidity among strangers. The Haas cohort already has both: shared trust and naturally clustered travel patterns around specific events (treks, recruiting weeks, weekend commutes). The gap isn't "no carpool tool exists" — it's "no one has built the version that fits a small, trusted, high-overlap community" instead of a stranger marketplace.

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
- **No formal identity verification (email login, magic link, or true campus SSO).** True CalNet-style single sign-on would require UC Berkeley IT to register this as an approved service provider — not achievable for a v1 build. Trust instead comes from the distribution channel itself: the link only ever circulates inside the private Haas WhatsApp chat, so anyone who has it is already a verified member of that trusted group. Only a name is collected, and it's remembered locally after first use so it isn't re-entered on every visit.
- **No native mobile app.** A mobile-friendly web link is the right form factor — zero install friction, one tap from a WhatsApp message.

---

## User Stories

- As a student without a car, I want to post my trip need (date, time, origin, destination) so that others going the same way can see it.
- As a student with a car, I want to indicate that I'm driving and how many seats I have so that others can find and join me.
- As a student browsing, I want to see requests and offers grouped by route and date so I can find a match without reading unrelated posts.
- As a student who just posted, I want a ready-to-paste summary of my request so I can drop it back into the WhatsApp chat without retyping it.
- As a student, I want to be notified if a match appears in my category after I've posted, so I don't have to keep checking back.
- As a returning user, I want the app to remember my name after my first post so that I don't have to retype it every time I use it.

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
| Shareable output text | Given a user submits a post, when submission completes, then the system generates a pre-formatted text summary the user can copy and paste into WhatsApp. |
| Shareable app link | Given the app is deployed, when accessed via a shared link, then it loads without requiring app installation. |
| Post expiration | Given a post's trip date has passed, when the system runs its daily cleanup check, then the post is automatically removed from the board. |

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
- **"Remembered identity" is scoped to a single device/browser.** If a student posts from their laptop and later opens the link on their phone, they'll be asked for their name again. Worth deciding whether that's acceptable for v1 or needs a fix. *(Product decision — recommend accepting as a known v1 limitation.)*
- **Does removing an expired post also need to notify anyone who had a pending interest in it?** — minor, but worth a quick decision so users aren't left wondering why a post disappeared. *(Product/design.)*

---

## Timeline Considerations

- Target build window: 2–4 weeks, aiming for a usable v1 in market by mid-to-late September, ahead of the busiest recruiting-trek season and before your own interview prep window narrows.
- No external hard deadline — but real usage data is most valuable if the tool is live during an actual high-travel period (recruiting treks, a recruiting-adjacent weekend), so earlier is meaningfully better than later.
