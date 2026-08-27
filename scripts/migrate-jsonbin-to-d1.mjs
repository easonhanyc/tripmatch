#!/usr/bin/env node
/**
 * One-shot migration: JSONBin board -> D1 seed SQL.
 *
 * Reads the existing bin, converts every post (with its comments and +1s)
 * into INSERT statements, and writes them to worker/seed.sql. It does not
 * touch the bin and does not talk to D1 — you review the SQL, then apply it
 * with wrangler. Nothing is destructive at any step.
 *
 * Imported posts have no author_email, because the old board never collected
 * one. The worker treats a NULL author_email as "match on display name
 * instead" (see ownsPost) so the people who posted before launch keep control
 * of their own posts. The first time one of them edits a post, their verified
 * email is written in and the name fallback stops applying to it.
 *
 * Usage:
 *   node scripts/migrate-jsonbin-to-d1.mjs \
 *     --bin 6a8a4416f5f4af5e2936f5b2 \
 *     --key "$JSONBIN_KEY" \
 *     > worker/seed.sql
 *
 * Then:
 *   cd worker && npx wrangler d1 execute tripmatch --remote --file=./seed.sql
 */

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

if (!args.bin || !args.key) {
  console.error("usage: migrate-jsonbin-to-d1.mjs --bin <BIN_ID> --key <MASTER_OR_ACCESS_KEY>");
  process.exit(1);
}

const REGIONS = ["East Bay / Campus", "San Francisco", "Peninsula", "South Bay", "Other"];

function q(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function newId(seed, i) {
  return String(seed || Date.now()).slice(0, 13) + "-i" + String(i).padStart(4, "0");
}

const res = await fetch(`https://api.jsonbin.io/v3/b/${args.bin}/latest`, {
  headers: { "X-Master-Key": args.key },
});
if (!res.ok) {
  console.error(`JSONBin read failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}

const data = await res.json();
const posts = (data && data.record && data.record.posts) || [];

// No BEGIN TRANSACTION / COMMIT here. `wrangler d1 execute --file` runs the
// whole file inside a transaction it manages itself, and rejects an explicit
// one outright ("please use the state.storage.transaction() APIs instead").
// The import is still all-or-nothing — that guarantee comes from D1, not from
// statements in this file.
const lines = [
  "-- TripMatch: posts migrated from the JSONBin board.",
  `-- Generated ${new Date().toISOString()} from bin ${args.bin} (${posts.length} posts).`,
  "-- Imported posts have author_email NULL; ownership falls back to a name",
  "-- match until the owner next edits, which stamps their verified email in.",
  "-- Apply with: wrangler d1 execute tripmatch --remote --file=./seed.sql",
];

let nComments = 0;
let nPlus = 0;

posts.forEach((p, i) => {
  const id = newId(p.createdAt || p.id, i);
  const created = Number(p.createdAt) || Date.now();
  const originRegion = REGIONS.includes(p.originRegion) ? p.originRegion : "Other";
  const destRegion = REGIONS.includes(p.destRegion) ? p.destRegion : "Other";
  const role = p.role === "driver" ? "driver" : "rider";

  lines.push(
    `INSERT INTO posts (id, author_email, author_name, role, seats, trip_date, trip_time, notes, origin_city, dest_city, origin_region, dest_region, created_at, updated_at) VALUES (` +
      [
        q(id), "NULL", q(String(p.name || "Unknown").slice(0, 60)), q(role),
        Number(p.seats) || 0, q(p.date || ""), q(p.time || ""),
        q(String(p.notes || "").slice(0, 300)),
        q(String(p.originCity || "").slice(0, 60)), q(String(p.destCity || "").slice(0, 60)),
        q(originRegion), q(destRegion), created, created,
      ].join(", ") + ");"
  );

  (p.comments || []).forEach((c, j) => {
    nComments++;
    lines.push(
      `INSERT INTO comments (id, post_id, author_email, author_name, body, created_at) VALUES (` +
        [
          q(`${id}-c${j}`), q(id), "NULL",
          q(String(c.name || "Unknown").slice(0, 60)),
          q(String(c.text || "").slice(0, 300)),
          Number(c.createdAt) || created,
        ].join(", ") + ");"
    );
  });

  // De-duplicate by lowercased name: the old list was a plain array with no
  // uniqueness guarantee, and the new table's primary key would reject a
  // repeat mid-transaction, taking the whole import down with it.
  const seen = new Set();
  (p.plusOnes || []).forEach((po) => {
    const key = String(po.name || "").trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    nPlus++;
    lines.push(
      `INSERT INTO plus_ones (post_id, author_email, author_name, created_at) VALUES (` +
        [
          q(id), q(`legacy:${key}`), q(String(po.name).slice(0, 60)),
          Number(po.createdAt) || created,
        ].join(", ") + ");"
    );
  });
});

lines.push(
  `INSERT INTO audit_log (ts, actor_email, actor_name, action, entity_type, detail) VALUES (` +
    [
      Date.now(), "NULL", q("system"), q("migration.import"), q("post"),
      q(JSON.stringify({ source: "jsonbin", bin: args.bin, posts: posts.length, comments: nComments, plusOnes: nPlus })),
    ].join(", ") + ");"
);
console.log(lines.join("\n"));
console.error(`Migrated ${posts.length} posts, ${nComments} comments, ${nPlus} +1s.`);
