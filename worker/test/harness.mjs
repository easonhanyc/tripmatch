// Test harness: runs the real worker.js against a real SQLite database via a
// D1-shaped shim, and against a real RSA-signed JWT served through a stubbed
// JWKS endpoint. Nothing about the worker is mocked out — the auth path,
// the SQL, the ownership checks and the rate limiter all execute for real.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

// ------------------------------------------------------------- D1 shim
class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...a) { this.args = a.map(v => (v === undefined ? null : v)); return this; }
  run() {
    const st = this.db.prepare(this.sql);
    const r = st.run(...this.args);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  first() {
    const st = this.db.prepare(this.sql);
    const rows = st.all(...this.args);
    return rows.length ? rows[0] : null;
  }
  all() {
    const st = this.db.prepare(this.sql);
    return { results: st.all(...this.args), success: true };
  }
}
class D1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new Stmt(this.db, sql); }
}

// --------------------------------------------------- fake Google identity
const enc = new TextEncoder();
const b64u = (b) => Buffer.from(b).toString("base64url");

const keyPair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"]
);
const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
jwk.kid = "test-key-1";
jwk.alg = "RS256";
jwk.use = "sig";

const CLIENT_ID = "test-client.apps.googleusercontent.com";

async function makeIdToken(overrides = {}) {
  const header = { alg: "RS256", kid: "test-key-1", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    exp: now + 3600,
    iat: now,
    email: "student@berkeley.edu",
    email_verified: true,
    hd: "berkeley.edu",
    name: "Test Student",
    ...overrides,
  };
  const body = b64u(JSON.stringify(header)) + "." + b64u(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, enc.encode(body));
  return body + "." + b64u(new Uint8Array(sig));
}

// Serve our test JWKS in place of Google's; everything else still fetches.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes("googleapis.com/oauth2/v3/certs")) {
    return new Response(JSON.stringify({ keys: [jwk] }), { headers: { "Content-Type": "application/json" } });
  }
  return realFetch(url, opts);
};

// ---------------------------------------------------------------- setup
const db = new DatabaseSync(":memory:");
const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
// Strip comment lines first: a statement preceded by a comment block would
// otherwise look like it starts with "--" and get skipped entirely.
// Strip comment lines first: a statement preceded by a comment block would
// otherwise look like it starts with "--" and get skipped entirely.
for (const stmt of schema.split(";")) {
  const t = stmt.split(String.fromCharCode(10))
    .filter(l => !l.trim().startsWith("--")).join(String.fromCharCode(10)).trim();
  if (t) { try { db.exec(t + ";"); } catch (e) { console.error("schema:", e.message, t.slice(0, 60)); } }
}

const worker = (await import("../worker.js")).default;

const env = {
  DB: new D1(db),
  GOOGLE_CLIENT_ID: CLIENT_ID,
  ALLOWED_ORIGINS: "https://tripmatch-app.github.io",
  ALLOWED_HD: "berkeley.edu",
  SESSION_SECRET: "test-secret-do-not-use-in-production",
  ADMIN_EMAILS: "admin@berkeley.edu",
};

const ORIGIN = "https://tripmatch-app.github.io";
async function call(method, path, { token, body, origin = ORIGIN } = {}) {
  const headers = { Origin: origin };
  if (token) headers.Authorization = "Bearer " + token;
  if (body) headers["Content-Type"] = "application/json";
  const req = new Request("https://api.test" + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  req.cf = { country: "US" };
  const res = await worker.fetch(req, env, {});
  let data = null;
  const text = await res.text();
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

export { call, makeIdToken, env, db, worker, ORIGIN, CLIENT_ID };
