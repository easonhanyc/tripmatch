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
await Promise.all(voters.map(t => call("POST", "/api/posts/" + postId + "/plusone", { token: t })));
r = await call("GET", "/api/board", { token: alice });
const plusCount = r.data.posts.find(p => p.id === postId)?.plusOnes.length;
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

console.log(results.join("\n"));
console.log(`\n${"=".repeat(50)}\n  ${pass} passed, ${fail} failed\n${"=".repeat(50)}`);
process.exit(fail > 0 ? 1 : 0);
