import { call, makeIdToken, env, db } from "./harness.mjs";

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra) {
  if (cond) { pass++; results.push("  ✓ " + name); }
  else { fail++; results.push("  ✗ " + name + (extra ? "  → " + JSON.stringify(extra) : "")); }
}
function group(n) { results.push("\n" + n); }

// Trip dates are Berkeley calendar days, so the fixtures must be too. Using
// UTC here silently breaks every evening after 5pm Pacific, when UTC has
// already rolled over and "UTC yesterday" is still today in Berkeley.
const pacificDay = (offsetDays) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date(Date.now() + offsetDays * 86400000));

const tomorrow = pacificDay(1);
const yesterday = pacificDay(-1);

// ------------------------------------------------------------- AUTH
group("Authentication & domain gate");

let r = await call("POST", "/api/auth/session", { body: { credential: await makeIdToken() } });
ok("valid berkeley.edu token issues a session", r.status === 200 && !!r.data.token, r.data);
const alice = r.data.token;
ok("session carries the verified name", r.data.user?.name === "Test Student", r.data.user);

r = await call("POST", "/api/auth/session", { body: { credential: await makeIdToken({ email: "someone@gmail.com", hd: undefined }) } });
ok("gmail.com account is rejected", r.status === 401 && r.data.error.code === "WRONG_DOMAIN", r.data);

r = await call("POST", "/api/auth/session", { body: { credential: await makeIdToken({ hd: "stanford.edu", email: "x@stanford.edu" }) } });
ok("another Workspace domain is rejected", r.status === 401 && r.data.error.code === "WRONG_DOMAIN", r.data);

r = await call("POST", "/api/auth/session", { body: { credential: await makeIdToken({ email_verified: false }) } });
ok("unverified email is rejected", r.status === 401, r.data);

r = await call("POST", "/api/auth/session", { body: { credential: await makeIdToken({ aud: "some-other-app.apps.googleusercontent.com" }) } });
ok("token minted for another app is rejected (audience)", r.status === 401 && r.data.error.code === "BAD_CREDENTIAL", r.data);

r = await call("POST", "/api/auth/session", { body: { credential: await makeIdToken({ exp: Math.floor(Date.now()/1000) - 60 }) } });
ok("expired Google token is rejected", r.status === 401, r.data);

r = await call("POST", "/api/auth/session", { body: { credential: await makeIdToken({ iss: "https://evil.example" }) } });
ok("wrong issuer is rejected", r.status === 401, r.data);

// Signature tampering: flip a character in the payload, keep the signature.
const good = await makeIdToken();
const [h, p_, s_] = good.split(".");
const tamperedPayload = Buffer.from(JSON.stringify({
  ...JSON.parse(Buffer.from(p_, "base64url").toString()), email: "dean@berkeley.edu",
})).toString("base64url");
r = await call("POST", "/api/auth/session", { body: { credential: `${h}.${tamperedPayload}.${s_}` } });
ok("tampered payload fails signature check", r.status === 401, r.data);

r = await call("GET", "/api/board");
ok("board requires a session", r.status === 401 && r.data.error.code === "UNAUTHENTICATED", r.data);

r = await call("GET", "/api/board", { token: "garbage.token" });
ok("forged session token is rejected", r.status === 401, r.data);

// Forge attempt: valid-looking payload, wrong HMAC signature.
const forgedBody = Buffer.from(JSON.stringify({ email: "admin@berkeley.edu", name: "Admin", exp: Date.now() + 1e6 })).toString("base64url");
r = await call("GET", "/api/board", { token: forgedBody + ".AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
ok("session token with a bad HMAC is rejected", r.status === 401, r.data);

// ------------------------------------------------------------- CORS
group("CORS / origin allow-list");

r = await call("GET", "/api/health", { origin: "https://evil.example" });
ok("disallowed origin is refused", r.status === 403, r.data);

r = await call("GET", "/api/health");
ok("allowed origin passes", r.status === 200 && r.data.ok === true, r.data);
ok("allow-origin header echoes the exact origin",
   r.headers.get("Access-Control-Allow-Origin") === "https://tripmatch-app.github.io");

r = await call("GET", "/api/health", { origin: "https://tripmatch-app.github.io.evil.com" });
ok("suffix-matching origin is refused", r.status === 403, r.data);

// ------------------------------------------------------------- POSTS
group("Posting & validation");

r = await call("POST", "/api/posts", { token: alice, body: {
  role: "driver", seats: 3, date: tomorrow, time: "09:30", notes: "one suitcase",
  originCity: "Berkeley", destCity: "San Jose",
  originRegion: "East Bay / Campus", destRegion: "South Bay" } });
ok("driver post is created", r.status === 201 && r.data.posts.length === 1, r.data);
const postId = r.data.id;
ok("post is attributed to the verified account", r.data.posts[0].mine === true, r.data.posts[0]);
ok("post name comes from the session, not the client", r.data.posts[0].name === "Test Student");
ok("board payload does not leak author email addresses",
   r.data.posts.every(p => p.email === undefined), r.data.posts[0]);

r = await call("POST", "/api/posts", { token: alice, body: {
  role: "driver", seats: 3, date: yesterday, originCity: "Berkeley", destCity: "San Jose" } });
ok("past-dated post is rejected", r.status === 400 && /past/.test(r.data.error.message), r.data);

r = await call("POST", "/api/posts", { token: alice, body: {
  role: "driver", seats: 99, date: tomorrow, originCity: "Berkeley", destCity: "San Jose" } });
ok("absurd seat count is rejected", r.status === 400, r.data);

r = await call("POST", "/api/posts", { token: alice, body: {
  role: "pilot", date: tomorrow, originCity: "Berkeley", destCity: "San Jose" } });
ok("invalid role is rejected", r.status === 400, r.data);

r = await call("POST", "/api/posts", { token: alice, body: {
  role: "rider", date: tomorrow, time: "25:99", originCity: "Berkeley", destCity: "SF" } });
ok("invalid time is rejected", r.status === 400, r.data);

r = await call("POST", "/api/posts", { token: alice, body: {
  role: "rider", date: tomorrow, originCity: "Berkeley", destCity: "SF",
  originRegion: "Mars", destRegion: "Mars" } });
ok("unknown region falls back to Other rather than erroring", r.status === 201, r.data);
ok("region coerced to Other", r.data.posts.some(p => p.originRegion === "Other"));

// XSS: the field must survive as literal text, not be silently stripped —
// escaping is the front-end's job at render time, storage stays faithful.
r = await call("POST", "/api/posts", { token: alice, body: {
  role: "rider", date: tomorrow, notes: "<script>alert(1)</script>",
  originCity: "Berkeley", destCity: "SF" } });
const xssPost = r.data.posts.find(p => p.notes.includes("script"));
ok("script tag stored verbatim (escaped at render, not at write)",
   xssPost?.notes === "<script>alert(1)</script>", xssPost?.notes);

// ------------------------------------------------------- OWNERSHIP
group("Ownership across identities");

const bob = (await call("POST", "/api/auth/session", { body: {
  credential: await makeIdToken({ email: "bob@berkeley.edu", name: "Bob Rider" }) } })).data.token;

r = await call("PATCH", "/api/posts/" + postId, { token: bob, body: {
  role: "driver", seats: 1, date: tomorrow, originCity: "Berkeley", destCity: "San Jose" } });
ok("another user cannot edit your post", r.status === 403, r.data);

r = await call("DELETE", "/api/posts/" + postId, { token: bob });
ok("another user cannot delete your post", r.status === 403, r.data);

r = await call("PATCH", "/api/posts/" + postId, { token: alice, body: {
  role: "driver", seats: 4, date: tomorrow, time: "10:00",
  originCity: "Berkeley", destCity: "San Jose",
  originRegion: "East Bay / Campus", destRegion: "South Bay" } });
ok("owner can edit their own post", r.status === 200, r.data);
ok("edit applied", r.data.posts.find(p => p.id === postId)?.seats === 4);

// Cross-device: a second sign-in from the same account is a different
// session token but the same identity, which is the whole point of the change.
const aliceOtherDevice = (await call("POST", "/api/auth/session", { body: { credential: await makeIdToken() } })).data.token;
ok("second device gets a different session token", aliceOtherDevice !== alice);
r = await call("PATCH", "/api/posts/" + postId, { token: aliceOtherDevice, body: {
  role: "driver", seats: 5, date: tomorrow, originCity: "Berkeley", destCity: "San Jose" } });
ok("same account edits its post from a second device", r.status === 200, r.data);

// ------------------------------------------------------------- PLUS ONE
group("+1 concurrency");

r = await call("POST", "/api/posts/" + postId + "/plusone", { token: alice });
ok("owner cannot +1 their own post", r.status === 400, r.data);

r = await call("POST", "/api/posts/" + postId + "/plusone", { token: bob });
ok("another user can +1", r.status === 200, r.data);
ok("+1 recorded once", r.data.posts.find(p => p.id === postId)?.plusOnes.length === 1);

r = await call("POST", "/api/posts/" + postId + "/plusone", { token: bob });
ok("+1 toggles off", r.data.posts.find(p => p.id === postId)?.plusOnes.length === 0);

// The old build lost writes here: read-all, mutate, write-all. Fire a burst
// concurrently and confirm every one is retained.
group("Concurrent writes (the JSONBin lost-update bug)");

const voters = [];
for (let i = 0; i < 12; i++) {
  voters.push((await call("POST", "/api/auth/session", { body: {
    credential: await makeIdToken({ email: `s${i}@berkeley.edu`, name: `Student ${i}` }) } })).data.token);
}
// This checks that concurrent writes don't overwrite one another, which is
// what the old whole-board rewrite got wrong. It has to run against a RIDER
// post: on a driver's post the same burst is correctly capped at the seat
// count, and the capacity race is covered separately below.
const meToo = (await call("POST", "/api/posts", { token: alice, body: {
  role: "rider", date: tomorrow, notes: "concurrency me-too",
  originCity: "Berkeley", destCity: "San Francisco",
  originRegion: "East Bay / Campus", destRegion: "San Francisco" } })).data.posts
  .find(p => p.notes === "concurrency me-too");

await Promise.all(voters.map(t => call("POST", "/api/posts/" + meToo.id + "/plusone", { token: t })));
r = await call("GET", "/api/board", { token: alice });
const plusCount = r.data.posts.find(p => p.id === meToo.id)?.plusOnes.length;
ok("12 simultaneous +1s all persisted", plusCount === 12, { got: plusCount });

const before = (await call("GET", "/api/board", { token: alice })).data.posts.length;
await Promise.all(voters.map((t, i) => call("POST", "/api/posts", { token: t, body: {
  role: "rider", date: tomorrow, notes: "burst " + i,
  originCity: "Berkeley", destCity: "San Francisco",
  originRegion: "East Bay / Campus", destRegion: "San Francisco" } })));
const after = (await call("GET", "/api/board", { token: alice })).data.posts.length;
ok("12 simultaneous posts all persisted", after === before + 12, { before, after });

await Promise.all(voters.map((t, i) => call("POST", "/api/posts/" + postId + "/comments", {
  token: t, body: { text: "comment " + i } })));
r = await call("GET", "/api/board", { token: alice });
const cCount = r.data.posts.find(p => p.id === postId)?.comments.length;
ok("12 simultaneous comments all persisted", cCount === 12, { got: cCount });

// ------------------------------------------------------------- DELETE
group("Deletion");

r = await call("DELETE", "/api/posts/" + postId, { token: alice });
ok("owner can delete their own post", r.status === 200, r.data);
ok("deleted post leaves the board", !r.data.posts.some(p => p.id === postId));

const row = db.prepare("SELECT deleted_at FROM posts WHERE id = ?").get(postId);
ok("delete is soft — the row and its history survive", row && row.deleted_at !== null, row);

r = await call("DELETE", "/api/posts/" + postId, { token: alice });
ok("deleting twice is a clean 404, not a crash", r.status === 404, r.data);

// ------------------------------------------------------- LEGACY IMPORT
group("Legacy (pre-auth) post ownership");

db.prepare(`INSERT INTO posts (id, author_email, author_name, role, seats, trip_date, trip_time, notes,
  origin_city, dest_city, origin_region, dest_region, created_at, updated_at)
  VALUES ('legacy-1', NULL, 'Test Student', 'rider', 0, ?, '', '', 'Berkeley', 'Palo Alto',
  'East Bay / Campus', 'Peninsula', ?, ?)`).run(tomorrow, Date.now(), Date.now());

r = await call("PATCH", "/api/posts/legacy-1", { token: bob, body: {
  role: "rider", date: tomorrow, originCity: "Berkeley", destCity: "Palo Alto" } });
ok("a stranger cannot claim a legacy post", r.status === 403, r.data);

r = await call("PATCH", "/api/posts/legacy-1", { token: alice, body: {
  role: "rider", date: tomorrow, notes: "updated", originCity: "Berkeley", destCity: "Palo Alto",
  originRegion: "East Bay / Campus", destRegion: "Peninsula" } });
ok("the original poster keeps control by name match", r.status === 200, r.data);

const claimed = db.prepare("SELECT author_email FROM posts WHERE id='legacy-1'").get();
ok("editing stamps the verified email in, retiring the name fallback",
   claimed.author_email === "student@berkeley.edu", claimed);

// ------------------------------------------------------------- ADMIN
group("Audit log access control");

r = await call("GET", "/api/logs", { token: bob });
ok("non-admin cannot read the log", r.status === 403, r.data);

const admin = (await call("POST", "/api/auth/session", { body: {
  credential: await makeIdToken({ email: "admin@berkeley.edu", name: "Eason Han" }) } })).data.token;
r = await call("GET", "/api/logs", { token: admin });
ok("admin can read the log", r.status === 200 && Array.isArray(r.data.rows), r.data);
ok("log captured logins", r.data.rows.some(x => x.action === "login"));
ok("log captured post creation", r.data.rows.some(x => x.action === "post.create"));
ok("log captured deletion", r.data.rows.some(x => x.action === "post.delete"));
ok("log captured a denied edit", r.data.rows.some(x => x.action === "post.update.denied"));
ok("log captured comments", r.data.rows.some(x => x.action === "comment.create"));
ok("log rows carry actor identity", r.data.rows.every(x => x.action.startsWith("login.rejected") || x.actor_email || x.actor_name));
ok("log rows carry a timestamp", r.data.rows.every(x => typeof x.ts === "number" && x.ts > 0));

const del = r.data.rows.find(x => x.action === "post.delete");
ok("delete log records what was deleted", del && JSON.parse(del.detail).route === "Berkeley → San Jose", del?.detail);

const upd = r.data.rows.find(x => x.action === "post.update" && x.detail.includes("seats"));
ok("update log records before → after", upd && JSON.parse(upd.detail).changed.seats, upd?.detail);

r = await call("GET", "/api/logs?format=csv", { token: admin });
ok("CSV export works", typeof r.data === "string" && r.data.startsWith("id,ts,iso,actor_email"), String(r.data).slice(0, 60));

r = await call("GET", "/api/logs?action=login", { token: admin });
ok("log filters by action", r.data.rows.every(x => x.action === "login"));

r = await call("GET", "/api/logs?actor=bob@berkeley.edu", { token: admin });
ok("log filters by actor", r.data.rows.length > 0 && r.data.rows.every(x => x.actor_email === "bob@berkeley.edu"));

// --------------------------------------------------------- RATE LIMIT
group("Rate limiting");

const spammer = (await call("POST", "/api/auth/session", { body: {
  credential: await makeIdToken({ email: "spam@berkeley.edu", name: "Spammer" }) } })).data.token;
let limited = false;
for (let i = 0; i < 30; i++) {
  const rr = await call("POST", "/api/posts", { token: spammer, body: {
    role: "rider", date: tomorrow, notes: "spam " + i, originCity: "Berkeley", destCity: "SF" } });
  if (rr.status === 429) { limited = true; break; }
}
ok("a burst of writes is rate limited", limited);
r = await call("GET", "/api/board", { token: alice });
ok("rate-limited user can still read the board", r.status === 200);

// --------------------------------------------------------- EXPIRY
group("Scheduled expiry");

db.prepare(`INSERT INTO posts (id, author_email, author_name, role, seats, trip_date, trip_time, notes,
  origin_city, dest_city, origin_region, dest_region, created_at, updated_at)
  VALUES ('stale-1', 'student@berkeley.edu', 'Test Student', 'rider', 0, ?, '', '', 'Berkeley', 'SF',
  'East Bay / Campus', 'San Francisco', ?, ?)`).run(yesterday, Date.now(), Date.now());

r = await call("GET", "/api/board", { token: alice });
ok("past-dated post never appears on the board", !r.data.posts.some(p => p.id === "stale-1"));

const { default: w } = await import("../worker.js");
await w.scheduled({}, env, {});
const stale = db.prepare("SELECT deleted_at FROM posts WHERE id='stale-1'").get();
ok("the daily job archives past-dated posts", stale.deleted_at !== null, stale);

r = await call("GET", "/api/logs?action=post.expire", { token: admin });
ok("expiry is logged", r.data.rows.length > 0, r.data.rows);

// ------------------------------------------------------------- MISC
group("Misc");

r = await call("GET", "/api/nonexistent", { token: alice });
ok("unknown endpoint returns a clean 404", r.status === 404 && r.data.error.code === "NOT_FOUND", r.data);

r = await call("POST", "/api/posts/does-not-exist/comments", { token: alice, body: { text: "hi" } });
ok("commenting on a missing post is a clean 404", r.status === 404, r.data);

r = await call("POST", "/api/posts", { token: alice, body: {} });
ok("empty post body is a clean 400", r.status === 400, r.data);

r = await call("GET", "/api/me", { token: admin });
ok("/api/me reports admin status", r.data.isAdmin === true, r.data);
r = await call("GET", "/api/me", { token: bob });
ok("/api/me denies admin for regular users", r.data.isAdmin === false, r.data);


// ---------------------------------------------------- SCALE & PRIVACY
group("Scale & privacy regressions");

// The board query used to build an IN(?,?,...) with one bound parameter per
// post, which hits D1's per-query parameter cap right around this size.
const bulk = [];
for (let i = 0; i < 120; i++) {
  bulk.push(call("POST", "/api/posts", { token: voters[i % voters.length], body: {
    role: "rider", date: tomorrow, notes: "scale " + i,
    originCity: "Berkeley", destCity: "San Francisco",
    originRegion: "East Bay / Campus", destRegion: "San Francisco" } }));
}
await Promise.all(bulk);
r = await call("GET", "/api/board", { token: alice });
ok("board loads with 100+ posts (D1 bound-parameter cap)", r.status === 200, { status: r.status, err: r.data.error });
ok("all bulk posts are present", r.data.posts.length >= 120, { n: r.data.posts.length });

r = await call("GET", "/api/board", { token: bob });
ok("no author emails anywhere in the board payload",
   !JSON.stringify(r.data.posts).includes("@berkeley.edu"));
ok("+1 entries carry a mine flag instead of an email",
   r.data.posts.every(p => (p.plusOnes || []).every(o => o.email === undefined && "mine" in o)));

// The same post must report mine:true to its author and mine:false to
// everyone else — the flag is computed per request, not stored on the row.
const bobPost = (await call("POST", "/api/posts", { token: bob, body: {
  role: "rider", date: tomorrow, notes: "bob's own",
  originCity: "Berkeley", destCity: "Palo Alto",
  originRegion: "East Bay / Campus", destRegion: "Peninsula" } })).data.posts
  .find(p => p.notes === "bob's own");

const asBob = (await call("GET", "/api/board", { token: bob })).data.posts.find(p => p.id === bobPost.id);
const asAlice = (await call("GET", "/api/board", { token: alice })).data.posts.find(p => p.id === bobPost.id);
ok("mine is true for the author", asBob.mine === true, asBob);
ok("mine is false for everyone else", asAlice.mine === false, asAlice);

// A legacy post's own author must not be able to +1 it.
db.prepare(`INSERT INTO posts (id, author_email, author_name, role, seats, trip_date, trip_time, notes,
  origin_city, dest_city, origin_region, dest_region, created_at, updated_at)
  VALUES ('legacy-2', NULL, 'Test Student', 'driver', 2, ?, '', '', 'Berkeley', 'SF',
  'East Bay / Campus', 'San Francisco', ?, ?)`).run(tomorrow, Date.now(), Date.now());

r = await call("POST", "/api/posts/legacy-2/plusone", { token: alice });
ok("legacy post's own author cannot +1 it", r.status === 400, r.data);

r = await call("POST", "/api/posts/legacy-2/plusone", { token: bob });
ok("someone else still can +1 a legacy post", r.status === 200, r.data);

// CSV formula injection. The column that reaches a spreadsheet cell as raw
// text is actor_name — it comes from the Google profile, so it is not fully
// under our control. `detail` is always JSON and therefore starts with "{",
// which is not a formula; assert we leave that alone rather than mangling it.
db.prepare(`INSERT INTO audit_log (ts, actor_email, actor_name, action, entity_type, entity_id, detail)
  VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
  Date.now(), "sneaky@berkeley.edu", '=HYPERLINK("http://evil","click")',
  "post.create", "post", "p-csv", JSON.stringify({ text: "hello" }));

r = await call("GET", "/api/logs?format=csv&limit=5000", { token: admin });
const csvLine = String(r.data).split("\n").find(l => l.includes("HYPERLINK"));
ok("CSV neutralises a formula-shaped display name", !!csvLine && csvLine.includes("\"'=HYPERLINK"), csvLine);
ok("CSV leaves JSON detail columns untouched", !!csvLine && csvLine.includes('{""text""'), csvLine);


// -------------------------------------------------- ADMIN MODERATION
group("Admin moderation");

// A post owned by an ordinary user, for the admin to act on.
const modPost = (await call("POST", "/api/posts", { token: bob, body: {
  role: "driver", seats: 2, date: tomorrow, time: "07:00", notes: "bob's trip to moderate",
  originCity: "Berkeley", destCity: "San Jose",
  originRegion: "East Bay / Campus", destRegion: "South Bay" } })).data.posts
  .find(p => p.notes === "bob's trip to moderate");

let board = (await call("GET", "/api/board", { token: admin })).data.posts;
let seenByAdmin = board.find(p => p.id === modPost.id);
ok("admin may manage a post they don't own", seenByAdmin.canManage === true, seenByAdmin);
ok("...but it is not reported as theirs", seenByAdmin.mine === false, seenByAdmin);

board = (await call("GET", "/api/board", { token: alice })).data.posts;
const seenByAlice = board.find(p => p.id === modPost.id);
ok("a non-admin may not manage someone else's post", seenByAlice.canManage === false, seenByAlice);

board = (await call("GET", "/api/board", { token: bob })).data.posts;
const seenByBob = board.find(p => p.id === modPost.id);
ok("the author may manage their own post", seenByBob.canManage === true && seenByBob.mine === true, seenByBob);

// Admin edit must not quietly reassign authorship.
r = await call("PATCH", "/api/posts/" + modPost.id, { token: admin, body: {
  role: "driver", seats: 1, date: tomorrow, time: "07:00", notes: "trimmed by admin",
  originCity: "Berkeley", destCity: "San Jose",
  originRegion: "East Bay / Campus", destRegion: "South Bay" } });
ok("admin can edit another user's post", r.status === 200, r.data);

let modRow = db.prepare("SELECT author_email, author_name FROM posts WHERE id = ?").get(modPost.id);
ok("admin edit leaves authorship with the original poster",
   modRow.author_email === "bob@berkeley.edu" && modRow.author_name === "Bob Rider", modRow);

r = await call("GET", "/api/logs?action=post.update", { token: admin });
const adminEdit = r.data.rows.find(x => x.entity_id === modPost.id);
ok("admin edit is logged as an admin action", adminEdit && JSON.parse(adminEdit.detail).asAdmin === true, adminEdit?.detail);

// An admin still isn't the owner, so +1 must remain available to them.
r = await call("POST", "/api/posts/" + modPost.id + "/plusone", { token: admin });
ok("admin can still +1 a post they moderate", r.status === 200, r.data);

// A legacy post must not be silently claimed by an admin either.
db.prepare(`INSERT INTO posts (id, author_email, author_name, role, seats, trip_date, trip_time, notes,
  origin_city, dest_city, origin_region, dest_region, created_at, updated_at)
  VALUES ('legacy-3', NULL, 'Someone Else', 'rider', 0, ?, '', '', 'Berkeley', 'SF',
  'East Bay / Campus', 'San Francisco', ?, ?)`).run(tomorrow, Date.now(), Date.now());

r = await call("PATCH", "/api/posts/legacy-3", { token: admin, body: {
  role: "rider", date: tomorrow, notes: "admin touched", originCity: "Berkeley", destCity: "SF",
  originRegion: "East Bay / Campus", destRegion: "San Francisco" } });
ok("admin can edit a legacy post", r.status === 200, r.data);
modRow = db.prepare("SELECT author_email FROM posts WHERE id='legacy-3'").get();
ok("admin editing a legacy post does not claim it", modRow.author_email === null, modRow);

// Deletion.
r = await call("DELETE", "/api/posts/" + modPost.id, { token: alice });
ok("a non-admin still cannot delete someone else's post", r.status === 403, r.data);

r = await call("DELETE", "/api/posts/" + modPost.id, { token: admin });
ok("admin can delete another user's post", r.status === 200, r.data);

r = await call("GET", "/api/logs?action=post.delete", { token: admin });
const adminDel = r.data.rows.find(x => x.entity_id === modPost.id);
ok("admin delete is logged as an admin action", adminDel && JSON.parse(adminDel.detail).asAdmin === true, adminDel?.detail);
ok("admin delete records whose post it was",
   adminDel && JSON.parse(adminDel.detail).author === "Bob Rider", adminDel?.detail);

// An ordinary user's own delete must NOT be tagged as an admin action.
const ownPost = (await call("POST", "/api/posts", { token: bob, body: {
  role: "rider", date: tomorrow, notes: "bob deletes his own",
  originCity: "Berkeley", destCity: "SF" } })).data.posts.find(p => p.notes === "bob deletes his own");
await call("DELETE", "/api/posts/" + ownPost.id, { token: bob });
r = await call("GET", "/api/logs?action=post.delete", { token: admin });
const ownDel = r.data.rows.find(x => x.entity_id === ownPost.id);
ok("an ordinary self-delete is not tagged asAdmin",
   ownDel && JSON.parse(ownDel.detail).asAdmin === undefined, ownDel?.detail);


// ------------------------------------------------------- SEAT CLAIMS
group("Seat claims on driver posts");

const carPost = (await call("POST", "/api/posts", { token: alice, body: {
  role: "driver", seats: 2, date: tomorrow, time: "08:00", notes: "two seater",
  originCity: "Berkeley", destCity: "San Francisco",
  originRegion: "East Bay / Campus", destRegion: "San Francisco" } })).data.posts
  .find(p => p.notes === "two seater");

r = await call("POST", "/api/posts/" + carPost.id + "/plusone", { token: alice });
ok("driver cannot take a seat in their own car", r.status === 400, r.data);

r = await call("POST", "/api/posts/" + carPost.id + "/plusone", { token: bob });
ok("a rider can take a seat", r.status === 200, r.data);
ok("seat is recorded", r.data.posts.find(p => p.id === carPost.id).plusOnes.length === 1);

r = await call("POST", "/api/posts/" + carPost.id + "/plusone", { token: voters[0] });
ok("a second rider fills the car", r.status === 200, r.data);
ok("two seats taken", r.data.posts.find(p => p.id === carPost.id).plusOnes.length === 2);

r = await call("POST", "/api/posts/" + carPost.id + "/plusone", { token: voters[1] });
ok("a third rider is refused — car is full", r.status === 409 && r.data.error.code === "SEATS_FULL", r.data);
ok("the refusal names the driver and the count",
   /Test Student's car is full/.test(r.data.error.message) && /2 seats/.test(r.data.error.message),
   r.data.error.message);

r = await call("GET", "/api/board", { token: alice });
ok("a refused claim adds nobody", r.data.posts.find(p => p.id === carPost.id).plusOnes.length === 2);

// Releasing frees the seat for someone else.
r = await call("POST", "/api/posts/" + carPost.id + "/plusone", { token: bob });
ok("a rider can give their seat back", r.status === 200 && r.data.posts.find(p => p.id === carPost.id).plusOnes.length === 1, r.data);
r = await call("POST", "/api/posts/" + carPost.id + "/plusone", { token: voters[1] });
ok("the freed seat can then be taken", r.status === 200, r.data);

// The race the capacity check exists for: many people, one seat.
const oneSeat = (await call("POST", "/api/posts", { token: alice, body: {
  role: "driver", seats: 1, date: tomorrow, notes: "last seat race",
  originCity: "Berkeley", destCity: "Oakland",
  originRegion: "East Bay / Campus", destRegion: "East Bay / Campus" } })).data.posts
  .find(p => p.notes === "last seat race");

const scramble = await Promise.all(
  voters.slice(0, 10).map(t => call("POST", "/api/posts/" + oneSeat.id + "/plusone", { token: t }))
);
const won = scramble.filter(x => x.status === 200).length;
const lost = scramble.filter(x => x.status === 409).length;
ok("exactly one of 10 simultaneous claims wins the single seat", won === 1, { won, lost });
ok("the other nine are cleanly refused", lost === 9, { won, lost });

r = await call("GET", "/api/board", { token: alice });
ok("the car holds exactly one rider afterwards",
   r.data.posts.find(p => p.id === oneSeat.id).plusOnes.length === 1);

// Rider posts stay uncapped — several people wanting the same trip is signal.
group("+1 on rider posts stays uncapped");

const needRide = (await call("POST", "/api/posts", { token: alice, body: {
  role: "rider", date: tomorrow, notes: "uncapped me-too",
  originCity: "Berkeley", destCity: "San Jose",
  originRegion: "East Bay / Campus", destRegion: "South Bay" } })).data.posts
  .find(p => p.notes === "uncapped me-too");

await Promise.all(voters.slice(0, 8).map(t => call("POST", "/api/posts/" + needRide.id + "/plusone", { token: t })));
r = await call("GET", "/api/board", { token: alice });
ok("eight people can +1 one rider post", r.data.posts.find(p => p.id === needRide.id).plusOnes.length === 8,
   { got: r.data.posts.find(p => p.id === needRide.id).plusOnes.length });

// The log should distinguish a seat claim from a me-too.
r = await call("GET", "/api/logs?action=seat.claim", { token: admin });
ok("seat claims are logged as seat.claim", r.data.rows.length > 0);
r = await call("GET", "/api/logs?action=seat.claim.full", { token: admin });
ok("refused claims are logged too", r.data.rows.length >= 9, { got: r.data.rows.length });
r = await call("GET", "/api/logs?action=plusone.add", { token: admin });
ok("rider me-toos stay plusone.add", r.data.rows.length > 0);


// --------------------------------------------------------- PARTY SIZE
group("Travelling with someone who isn't on TripMatch");

const bigCar = (await call("POST", "/api/posts", { token: alice, body: {
  role: "driver", seats: 4, date: tomorrow, time: "06:00", notes: "party size car",
  originCity: "Berkeley", destCity: "San Francisco",
  originRegion: "East Bay / Campus", destRegion: "San Francisco" } })).data.posts
  .find(p => p.notes === "party size car");

const seatsOf = async (tok, id) => {
  const b = (await call("GET", "/api/board", { token: tok })).data.posts.find(p => p.id === id);
  return { taken: b.seatsTaken, left: b.seats - b.seatsTaken, rows: b.plusOnes.length };
};

r = await call("POST", "/api/posts/" + bigCar.id + "/plusone", { token: bob, body: { party: 2 } });
ok("a rider can claim two seats", r.status === 200, r.data);
let st = await seatsOf(alice, bigCar.id);
ok("two seats are counted from one claim", st.taken === 2 && st.rows === 1, st);

r = await call("POST", "/api/posts/" + bigCar.id + "/plusone", { token: voters[0], body: { party: 3 } });
ok("a claim larger than the space left is refused", r.status === 409, r.data);
ok("the refusal says how many are actually free",
   /Only 2 seats left/.test(r.data.error.message), r.data.error.message);

st = await seatsOf(alice, bigCar.id);
ok("a refused claim changes nothing", st.taken === 2, st);

r = await call("POST", "/api/posts/" + bigCar.id + "/plusone", { token: voters[0], body: { party: 2 } });
ok("a claim that exactly fits succeeds", r.status === 200, r.data);
st = await seatsOf(alice, bigCar.id);
ok("the car is now full at 4 across 2 claims", st.taken === 4 && st.left === 0 && st.rows === 2, st);

r = await call("POST", "/api/posts/" + bigCar.id + "/plusone", { token: voters[1], body: { party: 1 } });
ok("a full car refuses even a single seat", r.status === 409, r.data);
ok("the full-car message is used when nothing is left",
   /car is full/.test(r.data.error.message), r.data.error.message);

// Changing your own party size must not double-count the seats you already hold.
r = await call("POST", "/api/posts/" + bigCar.id + "/plusone", { token: bob, body: { party: 1 } });
ok("shrinking your own claim is allowed in a full car", r.status === 200, r.data);
st = await seatsOf(alice, bigCar.id);
ok("shrinking frees a seat", st.taken === 3 && st.left === 1, st);

r = await call("POST", "/api/posts/" + bigCar.id + "/plusone", { token: bob, body: { party: 2 } });
ok("growing back into the free seat works", r.status === 200, r.data);
st = await seatsOf(alice, bigCar.id);
ok("car is full again", st.taken === 4, st);

r = await call("POST", "/api/posts/" + bigCar.id + "/plusone", { token: bob, body: { party: 3 } });
ok("growing beyond the free space is refused", r.status === 409, r.data);
st = await seatsOf(alice, bigCar.id);
ok("a refused resize leaves the original claim intact", st.taken === 4, st);

// Tapping with no party field at all means "leave".
r = await call("POST", "/api/posts/" + bigCar.id + "/plusone", { token: bob });
ok("tapping again with no party leaves the trip", r.status === 200, r.data);
st = await seatsOf(alice, bigCar.id);
ok("leaving frees the whole party", st.taken === 2 && st.rows === 1, st);

// The race, now with parties: 2 seats, everyone asking for 2.
const twoSeat = (await call("POST", "/api/posts", { token: alice, body: {
  role: "driver", seats: 2, date: tomorrow, notes: "party race",
  originCity: "Berkeley", destCity: "Oakland",
  originRegion: "East Bay / Campus", destRegion: "East Bay / Campus" } })).data.posts
  .find(p => p.notes === "party race");

const pairs = await Promise.all(
  voters.slice(0, 8).map(t => call("POST", "/api/posts/" + twoSeat.id + "/plusone", { token: t, body: { party: 2 } }))
);
ok("exactly one pair wins a two-seat car", pairs.filter(x => x.status === 200).length === 1,
   { won: pairs.filter(x => x.status === 200).length });
st = await seatsOf(alice, twoSeat.id);
ok("the car holds exactly two people", st.taken === 2, st);

// Rider posts: uncapped, and the count is people not claims.
const pairNeedsRide = (await call("POST", "/api/posts", { token: alice, body: {
  role: "rider", partySize: 2, date: tomorrow, notes: "two of us need a ride",
  originCity: "Berkeley", destCity: "San Jose",
  originRegion: "East Bay / Campus", destRegion: "South Bay" } })).data.posts
  .find(p => p.notes === "two of us need a ride");
ok("a rider post records how many need a ride", pairNeedsRide.partySize === 2, pairNeedsRide);

r = await call("POST", "/api/posts/" + pairNeedsRide.id + "/plusone", { token: bob, body: { party: 3 } });
ok("+1 on a rider post accepts a party", r.status === 200, r.data);
const rp = r.data.posts.find(p => p.id === pairNeedsRide.id);
ok("the party size is carried back to the client", rp.plusOnes[0].party === 3, rp.plusOnes);

r = await call("POST", "/api/posts", { token: alice, body: {
  role: "rider", partySize: 9, date: tomorrow, originCity: "Berkeley", destCity: "SF" } });
ok("an absurd party size on a post is rejected", r.status === 400, r.data);

r = await call("POST", "/api/posts/" + pairNeedsRide.id + "/plusone", { token: voters[2], body: { party: 99 } });
ok("an absurd party on a claim is clamped, not accepted as-is", r.status === 200, r.data);
const clamped = r.data.posts.find(p => p.id === pairNeedsRide.id).plusOnes.find(o => o.name === "Student 2");
ok("clamped to the maximum", clamped && clamped.party === 4, clamped);

// A driver post ignores partySize — its seats column is already the net figure.
r = await call("POST", "/api/posts", { token: alice, body: {
  role: "driver", seats: 2, partySize: 3, date: tomorrow, notes: "driver ignores party",
  originCity: "Berkeley", destCity: "SF" } });
const dp = r.data.posts.find(p => p.notes === "driver ignores party");
ok("a driver post ignores partySize", dp.partySize === 1, dp);

r = await call("GET", "/api/logs?action=seat.claim", { token: admin });
ok("seat claims log the party size", r.data.rows.some(x => JSON.parse(x.detail || "{}").party >= 2));

console.log(results.join("\n"));
console.log(`\n${"=".repeat(50)}\n  ${pass} passed, ${fail} failed\n${"=".repeat(50)}`);
process.exit(fail > 0 ? 1 : 0);
