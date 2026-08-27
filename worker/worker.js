/**
 * TripMatch API — Cloudflare Worker + D1
 *
 * Replaces the previous arrangement, where the browser held a JSONBin master
 * key in page source and every mutation rewrote the entire board as one JSON
 * blob. Two things were wrong with that and both are fixed here:
 *
 *   1. The key was public. Anyone who viewed source could rewrite or wipe the
 *      board. Secrets now live in Worker bindings and never reach the client.
 *   2. Writes were read-whole-array/write-whole-array, so two people posting
 *      within the same few seconds silently lost one post. Every mutation
 *      here is a targeted SQL statement against a single row.
 *
 * Identity is a Google ID token restricted to the berkeley.edu Workspace
 * domain (bMail), verified server-side against Google's JWKS. That is not
 * literally CalNet — true CalNet SSO needs UC Berkeley IT to register this as
 * a Service Provider — but every CalNet holder has a berkeley.edu Google
 * account, so it proves the same thing for our purposes. See INFRASTRUCTURE.md.
 *
 * Bindings required (see wrangler.toml):
 *   DB                  D1 database
 *   GOOGLE_CLIENT_ID    var    — public OAuth client ID
 *   ALLOWED_ORIGINS     var    — comma-separated exact origins for CORS
 *   ALLOWED_HD          var    — Google Workspace domain, e.g. "berkeley.edu"
 *   SESSION_SECRET      secret — HMAC key for session tokens
 *   ADMIN_EMAILS        secret — comma-separated, may read /api/logs
 */

const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];

// Per-actor write budget. Generous enough that no honest user will ever see
// it — a burst of ten posts in a minute is not a person coordinating a ride.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_WRITES = 20;

const MAX_NOTES = 300;
const MAX_COMMENT = 300;
const MAX_NAME = 60;
const MAX_CITY = 60;

// ---------------------------------------------------------------- utilities

function b64urlToBytes(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function jsonFromB64url(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

function newId() {
  return Date.now().toString(36) + "-" + crypto.randomUUID().slice(0, 8);
}

/**
 * Constant-time comparison. Session-token signatures are compared with this
 * rather than `===` so a timing side channel can't be walked toward a valid
 * signature one byte at a time.
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ------------------------------------------------------------------- CORS

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Exact-match only. No wildcard and no suffix matching, which would let
  // e.g. "evil-tripmatch-app.github.io" through.
  const ok = allowed.includes(origin);
  const headers = {
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (ok) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(body, status, request, env) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(request, env),
    },
  });
}

/**
 * Error shape is uniform on purpose: the front-end banner switches on `code`,
 * and shows `message` verbatim. Anything the user can act on should say so.
 */
function fail(code, message, status, request, env) {
  return json({ error: { code, message } }, status, request, env);
}

// ------------------------------------------------- Google ID token checking

let jwksCache = { keys: null, fetchedAt: 0 };
const JWKS_TTL_MS = 60 * 60 * 1000;

async function getGoogleKeys() {
  const now = Date.now();
  if (jwksCache.keys && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(GOOGLE_JWKS_URL);
  if (!res.ok) throw new Error("jwks_fetch_failed");
  const data = await res.json();
  jwksCache = { keys: data.keys, fetchedAt: now };
  return data.keys;
}

/**
 * Verify a Google Identity Services credential and return its claims.
 *
 * Checks, in order: structural validity, signature against Google's current
 * JWKS, issuer, audience (our client ID — this is what stops a token minted
 * for some other app being replayed here), expiry, verified email, and
 * finally the Workspace domain. The `hd` claim is the berkeley.edu gate; it
 * is set by Google, not by the client, and cannot be forged without breaking
 * the signature.
 */
async function verifyGoogleToken(credential, env) {
  const parts = String(credential || "").split(".");
  if (parts.length !== 3) throw new Error("malformed_token");

  const header = jsonFromB64url(parts[0]);
  const payload = jsonFromB64url(parts[1]);

  if (header.alg !== "RS256") throw new Error("bad_alg");

  const keys = await getGoogleKeys();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("unknown_key");

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(parts[0] + "." + parts[1])
  );
  if (!valid) throw new Error("bad_signature");

  if (!GOOGLE_ISSUERS.includes(payload.iss)) throw new Error("bad_issuer");
  if (payload.aud !== env.GOOGLE_CLIENT_ID) throw new Error("bad_audience");

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < nowSec) throw new Error("expired");
  if (typeof payload.iat === "number" && payload.iat > nowSec + 300) throw new Error("bad_iat");

  if (payload.email_verified !== true) throw new Error("email_unverified");

  const wantHd = (env.ALLOWED_HD || "berkeley.edu").toLowerCase();
  const email = String(payload.email || "").toLowerCase();
  const hd = String(payload.hd || "").toLowerCase();

  // Belt and braces: trust `hd`, but also require the address itself to sit
  // in the domain. A personal gmail.com account has no `hd` at all and fails
  // the first check; this second one catches any aliasing oddity.
  if (hd !== wantHd || !email.endsWith("@" + wantHd)) throw new Error("wrong_domain");

  return {
    email,
    name: String(payload.name || email.split("@")[0]).slice(0, MAX_NAME),
    picture: payload.picture ? String(payload.picture).slice(0, 500) : null,
  };
}

// ----------------------------------------------------------- session tokens

async function hmacKey(env) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

/**
 * Sessions are stateless: a signed payload the client stores and echoes back,
 * so an authenticated request costs no database round trip. The trade-off is
 * that there's no server-side revocation — acceptable at this size, and the
 * 14-day expiry bounds it. If revocation is ever needed, add a `sessions`
 * table and check it here.
 */
async function mintSession(user, env) {
  const payload = {
    email: user.email,
    name: user.name,
    exp: Date.now() + SESSION_TTL_MS,
  };
  const body = bytesToB64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(body));
  return body + "." + bytesToB64url(new Uint8Array(sig));
}

async function readSession(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;

  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = bytesToB64url(
    new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(body)))
  );
  if (!timingSafeEqual(sig, expected)) return null;

  let payload;
  try {
    payload = jsonFromB64url(body);
  } catch {
    return null;
  }
  if (!payload.exp || payload.exp < Date.now()) return null;
  return { email: payload.email, name: payload.name };
}

// ------------------------------------------------------------------ logging

/**
 * Append one audit row. Deliberately never throws: a logging failure must not
 * turn a successful post into an error the user sees. A dropped log line is
 * a smaller problem than a lost trip post.
 */
async function logEvent(env, request, actor, action, entityType, entityId, detail) {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_log
         (ts, actor_email, actor_name, action, entity_type, entity_id, detail, ip, country, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        Date.now(),
        actor ? actor.email : null,
        actor ? actor.name : null,
        action,
        entityType || null,
        entityId || null,
        detail ? JSON.stringify(detail) : null,
        request.headers.get("CF-Connecting-IP") || null,
        (request.cf && request.cf.country) || null,
        (request.headers.get("User-Agent") || "").slice(0, 300) || null
      )
      .run();
  } catch (e) {
    console.error("audit log write failed", action, e);
  }
}

async function overRateLimit(env, actor) {
  try {
    const since = Date.now() - RATE_LIMIT_WINDOW_MS;
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_log
        WHERE actor_email = ? AND ts > ? AND action != 'login'`
    )
      .bind(actor.email, since)
      .first();
    return (row && row.n) >= RATE_LIMIT_MAX_WRITES;
  } catch {
    return false; // never block a write because the limiter itself failed
  }
}

// ------------------------------------------------------------- board reading

function todayInPacific() {
  // Trip dates are calendar days in Berkeley, not UTC. Without this, a post
  // for "today" vanishes from the board at 5pm Pacific when UTC rolls over.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * The whole board in three queries rather than one join, then stitched in
 * memory. At 200 posts this is trivially fast, and it avoids the row
 * multiplication a two-way join against comments and plus_ones would cause.
 */
async function loadBoard(env, session) {
  const today = todayInPacific();

  const postsRes = await env.DB.prepare(
    `SELECT * FROM posts
      WHERE deleted_at IS NULL AND trip_date >= ?
      ORDER BY trip_date ASC, trip_time ASC`
  )
    .bind(today)
    .all();

  const posts = postsRes.results || [];
  if (posts.length === 0) return [];

  // Joining against posts rather than listing ids keeps this at one bound
  // parameter regardless of board size. An `IN (?,?,…)` over every post id
  // would grow one parameter per post and hit D1's per-query parameter cap
  // right around the 200-post peak this board is sized for.
  const [commentsRes, plusRes] = await Promise.all([
    env.DB.prepare(
      `SELECT c.* FROM comments c
         JOIN posts p ON p.id = c.post_id
        WHERE p.deleted_at IS NULL AND p.trip_date >= ?
        ORDER BY c.created_at ASC`
    )
      .bind(today)
      .all(),
    env.DB.prepare(
      `SELECT o.* FROM plus_ones o
         JOIN posts p ON p.id = o.post_id
        WHERE p.deleted_at IS NULL AND p.trip_date >= ?
        ORDER BY o.created_at ASC`
    )
      .bind(today)
      .all(),
  ]);

  const byPost = new Map(posts.map((p) => [p.id, { comments: [], plusOnes: [] }]));

  for (const c of commentsRes.results || []) {
    const bucket = byPost.get(c.post_id);
    if (bucket) bucket.comments.push({ id: c.id, name: c.author_name, text: c.body, createdAt: c.created_at });
  }
  for (const o of plusRes.results || []) {
    const bucket = byPost.get(o.post_id);
    if (bucket) {
      bucket.plusOnes.push({
        name: o.author_name,
        mine: !!session && o.author_email === session.email,
        createdAt: o.created_at,
      });
    }
  }

  // Note what is NOT in this payload: author_email. Everyone signed in can
  // read the whole board, so anything included here is readable by all 400
  // students. Names are the point — they're how a match knows who to message
  // — but addresses aren't needed to render anything, so they stay in the
  // database. `mine` carries the only thing the client actually needs, and it
  // is decided by the same ownsPost the write endpoints enforce, so the
  // button you can see and the action the server will allow can't disagree.
  return posts.map((p) => ({
    id: p.id,
    mine: !!session && ownsPost(p, session),
    name: p.author_name,
    role: p.role,
    seats: p.seats,
    date: p.trip_date,
    time: p.trip_time,
    notes: p.notes,
    originCity: p.origin_city,
    destCity: p.dest_city,
    originRegion: p.origin_region,
    destRegion: p.dest_region,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    comments: byPost.get(p.id).comments,
    plusOnes: byPost.get(p.id).plusOnes,
  }));
}

// ------------------------------------------------------------- input checks

function cleanStr(v, max) {
  return String(v == null ? "" : v).trim().slice(0, max);
}

const REGIONS = ["East Bay / Campus", "San Francisco", "Peninsula", "South Bay", "Other"];

/**
 * Validate a post body. Returns { ok, fields } or { ok: false, message }.
 * The client validates too, but the client is not the authority — anything
 * that reaches the database has been through this function.
 */
function validatePostBody(body) {
  const role = body.role === "driver" || body.role === "rider" ? body.role : null;
  if (!role) return { ok: false, message: "Pick whether you're driving or need a ride." };

  const date = cleanStr(body.date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, message: "That date isn't valid." };
  if (date < todayInPacific()) return { ok: false, message: "That date is already in the past." };

  const time = cleanStr(body.time, 5);
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    return { ok: false, message: "That time isn't valid." };
  }

  const originCity = cleanStr(body.originCity, MAX_CITY);
  const destCity = cleanStr(body.destCity, MAX_CITY);
  if (!originCity || !destCity) return { ok: false, message: "Fill in both cities." };

  let seats = 0;
  if (role === "driver") {
    seats = parseInt(body.seats, 10);
    if (!Number.isInteger(seats) || seats < 1 || seats > 8) {
      return { ok: false, message: "Seats must be between 1 and 8." };
    }
  }

  const originRegion = REGIONS.includes(body.originRegion) ? body.originRegion : "Other";
  const destRegion = REGIONS.includes(body.destRegion) ? body.destRegion : "Other";

  return {
    ok: true,
    fields: {
      role,
      seats,
      date,
      time,
      notes: cleanStr(body.notes, MAX_NOTES),
      originCity,
      destCity,
      originRegion,
      destRegion,
    },
  };
}

/**
 * Ownership. Normally an exact email match.
 *
 * The name fallback exists only for posts imported from the pre-auth JSONBin
 * board, which have no author_email. Without it, everyone who posted before
 * launch would permanently lose the ability to edit or delete their own post.
 * It applies to those legacy rows only — once a post has an email, the name
 * is never consulted, so a new post can't be hijacked by picking someone
 * else's display name.
 */
function ownsPost(post, session) {
  if (post.author_email) return post.author_email === session.email;
  return (
    !!post.author_name &&
    post.author_name.trim().toLowerCase() === session.name.trim().toLowerCase()
  );
}

// ----------------------------------------------------------------- handlers

async function handleAuthSession(request, env) {
  const body = await request.json().catch(() => ({}));

  let user;
  try {
    user = await verifyGoogleToken(body.credential, env);
  } catch (e) {
    const domainProblem = e.message === "wrong_domain" || e.message === "email_unverified";
    await logEvent(env, request, null, "login.rejected", "session", null, { reason: e.message });
    return fail(
      domainProblem ? "WRONG_DOMAIN" : "BAD_CREDENTIAL",
      domainProblem
        ? `TripMatch is limited to ${env.ALLOWED_HD || "berkeley.edu"} accounts. Sign in with your Berkeley account.`
        : "Couldn't verify that sign-in. Try again.",
      401,
      request,
      env
    );
  }

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (email, name, picture, first_seen_at, last_seen_at, login_count)
     VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(email) DO UPDATE SET
       name = excluded.name,
       picture = excluded.picture,
       last_seen_at = excluded.last_seen_at,
       login_count = users.login_count + 1`
  )
    .bind(user.email, user.name, user.picture, now, now)
    .run();

  await logEvent(env, request, user, "login", "session", user.email, null);

  return json(
    { token: await mintSession(user, env), user: { email: user.email, name: user.name, picture: user.picture } },
    200,
    request,
    env
  );
}

/**
 * Expiry used to be opportunistic — whoever's browser loaded the board next
 * scrubbed past-dated posts for everyone. That worked but meant a client
 * could write on a read. Now the board query simply filters by date, and a
 * scheduled handler does the actual archiving once a day.
 */
async function handleBoard(request, env, session) {
  return json({ posts: await loadBoard(env, session), now: Date.now(), today: todayInPacific() }, 200, request, env);
}

async function handleCreatePost(request, env, session) {
  const body = await request.json().catch(() => ({}));
  const v = validatePostBody(body);
  if (!v.ok) return fail("INVALID", v.message, 400, request, env);

  const id = newId();
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO posts
       (id, author_email, author_name, role, seats, trip_date, trip_time, notes,
        origin_city, dest_city, origin_region, dest_region, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id, session.email, session.name, v.fields.role, v.fields.seats,
      v.fields.date, v.fields.time, v.fields.notes,
      v.fields.originCity, v.fields.destCity,
      v.fields.originRegion, v.fields.destRegion,
      now, now
    )
    .run();

  await logEvent(env, request, session, "post.create", "post", id, {
    role: v.fields.role,
    route: `${v.fields.originCity} → ${v.fields.destCity}`,
    date: v.fields.date,
    time: v.fields.time,
    seats: v.fields.seats,
  });

  return json({ id, posts: await loadBoard(env, session) }, 201, request, env);
}

async function handleUpdatePost(request, env, session, id) {
  const existing = await env.DB.prepare(`SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL`)
    .bind(id)
    .first();
  if (!existing) return fail("NOT_FOUND", "This post was removed — refresh the page.", 404, request, env);
  if (!ownsPost(existing, session)) {
    await logEvent(env, request, session, "post.update.denied", "post", id, null);
    return fail("FORBIDDEN", "You can only edit your own posts.", 403, request, env);
  }

  const body = await request.json().catch(() => ({}));
  const v = validatePostBody(body);
  if (!v.ok) return fail("INVALID", v.message, 400, request, env);

  const f = v.fields;
  await env.DB.prepare(
    `UPDATE posts SET
       role = ?, seats = ?, trip_date = ?, trip_time = ?, notes = ?,
       origin_city = ?, dest_city = ?, origin_region = ?, dest_region = ?,
       author_email = COALESCE(author_email, ?), updated_at = ?
     WHERE id = ?`
  )
    .bind(
      f.role, f.seats, f.date, f.time, f.notes,
      f.originCity, f.destCity, f.originRegion, f.destRegion,
      session.email, Date.now(), id
    )
    .run();

  // Log what actually changed, not the whole row — that's what makes the log
  // readable when you're trying to answer "who changed this and to what?"
  const changed = {};
  const map = {
    role: "role", seats: "seats", trip_date: "date", trip_time: "time",
    notes: "notes", origin_city: "originCity", dest_city: "destCity",
  };
  for (const [col, key] of Object.entries(map)) {
    if (String(existing[col]) !== String(f[key])) {
      changed[key] = { from: existing[col], to: f[key] };
    }
  }
  await logEvent(env, request, session, "post.update", "post", id, { changed });

  return json({ posts: await loadBoard(env, session) }, 200, request, env);
}

async function handleDeletePost(request, env, session, id) {
  const existing = await env.DB.prepare(`SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL`)
    .bind(id)
    .first();
  if (!existing) return fail("NOT_FOUND", "This post was already removed.", 404, request, env);
  if (!ownsPost(existing, session)) {
    await logEvent(env, request, session, "post.delete.denied", "post", id, null);
    return fail("FORBIDDEN", "You can only delete your own posts.", 403, request, env);
  }

  // Soft delete: the row stays, so the audit entry still points at something
  // real and a mistaken delete is one UPDATE away from being undone.
  await env.DB.prepare(`UPDATE posts SET deleted_at = ?, updated_at = ? WHERE id = ?`)
    .bind(Date.now(), Date.now(), id)
    .run();

  await logEvent(env, request, session, "post.delete", "post", id, {
    role: existing.role,
    route: `${existing.origin_city} → ${existing.dest_city}`,
    date: existing.trip_date,
    author: existing.author_name,
  });

  return json({ posts: await loadBoard(env, session) }, 200, request, env);
}

async function handleCreateComment(request, env, session, postId) {
  const post = await env.DB.prepare(`SELECT id FROM posts WHERE id = ? AND deleted_at IS NULL`)
    .bind(postId)
    .first();
  if (!post) return fail("NOT_FOUND", "This post was removed — refresh the page.", 404, request, env);

  const body = await request.json().catch(() => ({}));
  const text = cleanStr(body.text, MAX_COMMENT);
  if (!text) return fail("INVALID", "Write something first.", 400, request, env);

  const id = newId();
  await env.DB.prepare(
    `INSERT INTO comments (id, post_id, author_email, author_name, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, postId, session.email, session.name, text, Date.now())
    .run();

  await logEvent(env, request, session, "comment.create", "comment", id, { postId, text });

  return json({ posts: await loadBoard(env, session) }, 201, request, env);
}

async function handleTogglePlusOne(request, env, session, postId) {
  const post = await env.DB.prepare(
    `SELECT id, author_email, author_name FROM posts WHERE id = ? AND deleted_at IS NULL`
  )
    .bind(postId)
    .first();
  if (!post) return fail("NOT_FOUND", "This post was removed — refresh the page.", 404, request, env);
  // ownsPost, not a bare email comparison: a post imported from the old board
  // has no email, so the equality check was false for its own author and let
  // them +1 their own trip.
  if (ownsPost(post, session)) {
    return fail("INVALID", "You can't +1 your own post.", 400, request, env);
  }

  const existing = await env.DB.prepare(
    `SELECT 1 FROM plus_ones WHERE post_id = ? AND author_email = ?`
  )
    .bind(postId, session.email)
    .first();

  if (existing) {
    await env.DB.prepare(`DELETE FROM plus_ones WHERE post_id = ? AND author_email = ?`)
      .bind(postId, session.email)
      .run();
    await logEvent(env, request, session, "plusone.remove", "post", postId, null);
  } else {
    // OR IGNORE makes a double-tap idempotent rather than an error.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO plus_ones (post_id, author_email, author_name, created_at)
       VALUES (?, ?, ?, ?)`
    )
      .bind(postId, session.email, session.name, Date.now())
      .run();
    await logEvent(env, request, session, "plusone.add", "post", postId, null);
  }

  return json({ posts: await loadBoard(env, session) }, 200, request, env);
}

function isAdmin(env, session) {
  return (env.ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(session.email);
}

async function handleLogs(request, env, session, url) {
  if (!isAdmin(env, session)) {
    await logEvent(env, request, session, "logs.denied", null, null, null);
    return fail("FORBIDDEN", "The activity log is limited to TripMatch admins.", 403, request, env);
  }

  const limit = Math.min(parseInt(url.searchParams.get("limit") || "500", 10) || 500, 5000);
  const action = url.searchParams.get("action");
  const actor = url.searchParams.get("actor");
  const since = parseInt(url.searchParams.get("since") || "0", 10) || 0;

  let sql = `SELECT * FROM audit_log WHERE ts > ?`;
  const binds = [since];
  if (action) { sql += ` AND action = ?`; binds.push(action); }
  if (actor) { sql += ` AND actor_email = ?`; binds.push(actor.toLowerCase()); }
  sql += ` ORDER BY ts DESC LIMIT ?`;
  binds.push(limit);

  const res = await env.DB.prepare(sql).bind(...binds).all();
  const rows = res.results || [];

  if (url.searchParams.get("format") === "csv") {
    const cols = ["id", "ts", "iso", "actor_email", "actor_name", "action", "entity_type", "entity_id", "detail", "country"];
    const esc = (v) => {
      let s = v == null ? "" : String(v);
      // Notes and comment bodies are user-written and end up in this file.
      // Excel and Sheets execute a cell beginning = + - @ as a formula, so
      // neutralise it rather than shipping a spreadsheet that runs strangers'
      // input when an admin opens the log.
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [cols.join(",")];
    for (const r of rows) {
      lines.push(cols.map((c) => esc(c === "iso" ? new Date(r.ts).toISOString() : r[c])).join(","));
    }
    return new Response(lines.join("\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="tripmatch-log-${todayInPacific()}.csv"`,
        ...corsHeaders(request, env),
      },
    });
  }

  const stats = await env.DB.prepare(
    `SELECT action, COUNT(*) AS n FROM audit_log GROUP BY action ORDER BY n DESC`
  ).all();
  const users = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first();

  return json(
    { rows, totals: { byAction: stats.results || [], users: users ? users.n : 0 } },
    200,
    request,
    env
  );
}

async function handleHealth(request, env) {
  try {
    await env.DB.prepare(`SELECT 1`).first();
    return json({ ok: true, today: todayInPacific() }, 200, request, env);
  } catch (e) {
    return json({ ok: false, error: "database_unreachable" }, 503, request, env);
  }
}

// -------------------------------------------------------------------- router

const AUTHED_WRITES = new Set(["POST", "PATCH", "DELETE"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    // Reject cross-origin requests from anywhere we haven't allow-listed,
    // before any work happens. Same-origin and tool requests send no Origin.
    const origin = request.headers.get("Origin");
    if (origin && !corsHeaders(request, env)["Access-Control-Allow-Origin"]) {
      return fail("FORBIDDEN_ORIGIN", "This origin isn't allowed to use the TripMatch API.", 403, request, env);
    }

    try {
      if (path === "/api/health") return handleHealth(request, env);

      if (path === "/api/auth/session" && request.method === "POST") {
        return handleAuthSession(request, env);
      }

      const session = await readSession(request, env);
      if (!session) {
        return fail("UNAUTHENTICATED", "Sign in with your Berkeley account to continue.", 401, request, env);
      }

      if (AUTHED_WRITES.has(request.method) && (await overRateLimit(env, session))) {
        await logEvent(env, request, session, "rate_limited", null, null, { path, method: request.method });
        return fail("RATE_LIMITED", "That's a lot of activity at once — wait a minute and try again.", 429, request, env);
      }

      if (path === "/api/board" && request.method === "GET") return handleBoard(request, env, session);
      if (path === "/api/logs" && request.method === "GET") return handleLogs(request, env, session, url);
      if (path === "/api/me" && request.method === "GET") {
        return json({ user: session, isAdmin: isAdmin(env, session) }, 200, request, env);
      }
      if (path === "/api/posts" && request.method === "POST") return handleCreatePost(request, env, session);

      let m = path.match(/^\/api\/posts\/([A-Za-z0-9_-]+)$/);
      if (m) {
        if (request.method === "PATCH") return handleUpdatePost(request, env, session, m[1]);
        if (request.method === "DELETE") return handleDeletePost(request, env, session, m[1]);
      }

      m = path.match(/^\/api\/posts\/([A-Za-z0-9_-]+)\/comments$/);
      if (m && request.method === "POST") return handleCreateComment(request, env, session, m[1]);

      m = path.match(/^\/api\/posts\/([A-Za-z0-9_-]+)\/plusone$/);
      if (m && request.method === "POST") return handleTogglePlusOne(request, env, session, m[1]);

      return fail("NOT_FOUND", "No such endpoint.", 404, request, env);
    } catch (e) {
      // Anything unhandled: log it server-side with detail, tell the client
      // something honest but non-revealing, and let the banner take over.
      console.error("unhandled", path, request.method, e && e.stack);
      return fail("SERVER_ERROR", "TripMatch hit an unexpected error. Try again in a moment.", 500, request, env);
    }
  },

  /**
   * Daily archive pass (cron in wrangler.toml). The board already hides
   * past-dated posts, so this is housekeeping rather than correctness — it
   * keeps the live table small and leaves one log line a day showing what
   * aged out.
   */
  async scheduled(event, env, ctx) {
    const today = todayInPacific();
    const res = await env.DB.prepare(
      `UPDATE posts SET deleted_at = ? WHERE deleted_at IS NULL AND trip_date < ?`
    )
      .bind(Date.now(), today)
      .run();

    const n = (res.meta && res.meta.changes) || 0;
    if (n > 0) {
      await env.DB.prepare(
        `INSERT INTO audit_log (ts, actor_email, actor_name, action, entity_type, detail)
         VALUES (?, NULL, 'system', 'post.expire', 'post', ?)`
      )
        .bind(Date.now(), JSON.stringify({ count: n, before: today }))
        .run();
    }
  },
};
