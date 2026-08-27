#!/usr/bin/env node
/**
 * Generate a realistic test board as SQL.
 *
 * Exercises every feature at once: all four regions and both directions of
 * several corridors (so route colours are visibly distinct), multiple dates
 * (so the date-chip row appears), drivers at every capacity state (empty,
 * partly taken, exactly full), rider posts with varying interest, comment
 * threads, posts with and without a set time, an "other city" outside the
 * lookup table, and long notes.
 *
 * Everything it writes is tagged TESTDATA in the notes so it can be removed
 * again in one statement:
 *
 *   DELETE FROM plus_ones WHERE post_id IN (SELECT id FROM posts WHERE notes LIKE '%[TESTDATA]%');
 *   DELETE FROM comments  WHERE post_id IN (SELECT id FROM posts WHERE notes LIKE '%[TESTDATA]%');
 *   DELETE FROM posts     WHERE notes LIKE '%[TESTDATA]%';
 *
 * Usage: node scripts/seed-test-data.mjs > worker/testdata.sql
 */

const REGION = {
  Berkeley: "East Bay / Campus", Oakland: "East Bay / Campus",
  Emeryville: "East Bay / Campus", Albany: "East Bay / Campus",
  "San Francisco": "San Francisco",
  "Palo Alto": "Peninsula", "Menlo Park": "Peninsula", "Redwood City": "Peninsula",
  "San Mateo": "Peninsula", Burlingame: "Peninsula", "Foster City": "Peninsula",
  "Mountain View": "South Bay", Sunnyvale: "South Bay", "Santa Clara": "South Bay",
  "San Jose": "South Bay", Cupertino: "South Bay", Milpitas: "South Bay",
};

const q = (v) =>
  v === null || v === undefined ? "NULL"
  : typeof v === "number" ? String(v)
  : "'" + String(v).replace(/'/g, "''") + "'";

const pacific = (offset) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(Date.now() + offset * 86400000));

const D = { today: pacific(0), d1: pacific(1), d2: pacific(2), d3: pacific(3), d4: pacific(4) };
const email = (n) => n.toLowerCase().replace(/[^a-z]+/g, ".") + "@berkeley.edu";

let clock = Date.now() - 6 * 3600 * 1000;
const tick = () => (clock += 137000);

const TAG = "[TESTDATA]";

/* Each entry: driver posts carry `takers` (capped by seats), rider posts
   carry `plus` (uncapped). `comments` is [author, text]. */
const POSTS = [
  { who: "Priya Raghunathan", role: "driver", seats: 3, date: D.d1, time: "08:30",
    from: "Berkeley", to: "San Francisco",
    notes: "Heading to the Salesforce Tower trek, back around 4. Can drop at Embarcadero BART.",
    takers: ["Daniel Okafor"],
    comments: [["Daniel Okafor", "Perfect, I'll be at North Gate by 8:25."],
               ["Priya Raghunathan", "Great — I'm in a grey Corolla."]] },

  { who: "Marcus Bell", role: "driver", seats: 2, date: D.d1, time: "17:45",
    from: "San Francisco", to: "Berkeley",
    notes: "Return leg after the trek. Two spots, no big luggage please.",
    takers: ["Daniel Okafor", "Yuki Tanaka"],   // exactly full
    comments: [["Yuki Tanaka", "Grabbing the second seat, thanks!"]] },

  { who: "Chen Wei", role: "driver", seats: 4, date: D.d2, time: "07:15",
    from: "Berkeley", to: "Mountain View",
    notes: "Google office visit. Leaving from Unit 1, plenty of room for bags.",
    takers: ["Sofia Marchetti", "Tom Whelan"],
    comments: [] },

  { who: "Amara Nwosu", role: "rider", seats: 0, date: D.d2, time: "19:00",
    from: "Mountain View", to: "Berkeley",
    notes: "Need a ride back after the same visit — happy to split gas.",
    plus: ["Sofia Marchetti", "Tom Whelan", "Chen Wei"],
    comments: [["Chen Wei", "I'm driving back around 7:30 if that works?"],
               ["Amara Nwosu", "That works, thank you!"]] },

  { who: "Jonas Lindqvist", role: "driver", seats: 1, date: D.d2, time: "",
    from: "Berkeley", to: "Palo Alto",
    notes: "Flexible on timing — message me. One seat only.",
    takers: ["Ana Sousa"],                      // full at 1
    comments: [] },

  { who: "Ravi Krishnan", role: "rider", seats: 0, date: D.d3, time: "10:00",
    from: "Berkeley", to: "San Jose",
    notes: "SJC flight at 13:00, need to be there by noon. Will absolutely chip in.",
    plus: ["Nadia Hassan"],
    comments: [["Nadia Hassan", "Same flight window — want to split an Uber if nobody's driving?"]] },

  { who: "Elena Duarte", role: "driver", seats: 3, date: D.d3, time: "16:30",
    from: "San Jose", to: "Berkeley",
    notes: "Coming back up after a family thing. Happy to detour via Fremont BART.",
    takers: [],                                  // wide open
    comments: [] },

  { who: "Tom Whelan", role: "rider", seats: 0, date: D.d3, time: "11:30",
    from: "Berkeley", to: "Oakland",
    notes: "Just need a lift to Rockridge BART, five minutes out of the way.",
    plus: [],
    comments: [] },

  { who: "Sofia Marchetti", role: "driver", seats: 2, date: D.d4, time: "09:00",
    from: "San Francisco", to: "Palo Alto",
    notes: "Doing a Peninsula loop — can drop anywhere along the 101 corridor. " +
           "Leaving from the Mission, back up in the evening if anyone needs the return too.",
    takers: ["Ravi Krishnan"],
    comments: [["Ravi Krishnan", "Could you drop at Menlo Park instead? Happy either way."],
               ["Sofia Marchetti", "Menlo Park is fine, it's on the way."]] },

  { who: "Nadia Hassan", role: "rider", seats: 0, date: D.d4, time: "",
    from: "Palo Alto", to: "San Francisco",
    notes: "No fixed time, anywhere between noon and evening works.",
    plus: ["Amara Nwosu"],
    comments: [] },

  // An origin outside the lookup table — should bucket into "Other".
  { who: "Yuki Tanaka", role: "driver", seats: 2, date: D.d4, time: "13:00",
    from: "Davis", to: "Berkeley",
    notes: "Driving down from Davis after the weekend, two seats going spare.",
    takers: ["Marcus Bell"],
    comments: [] },

  // Same-day post, to prove today's trips still show.
  { who: "Daniel Okafor", role: "rider", seats: 0, date: D.today, time: "21:00",
    from: "San Francisco", to: "Berkeley",
    notes: "Late one — coming back after dinner in the Mission tonight.",
    plus: [],
    comments: [] },
];

const out = [
  "-- TripMatch test board. Every row is tagged [TESTDATA] in notes.",
  `-- Generated ${new Date().toISOString()}`,
  "-- Remove with the three DELETEs at the top of scripts/seed-test-data.mjs.",
];

POSTS.forEach((p, i) => {
  const id = `td-${i.toString().padStart(2, "0")}-${Math.random().toString(36).slice(2, 8)}`;
  const created = tick();
  const notes = `${p.notes} ${TAG}`;

  out.push(
    `INSERT INTO posts (id, author_email, author_name, role, seats, trip_date, trip_time, notes, ` +
    `origin_city, dest_city, origin_region, dest_region, created_at, updated_at) VALUES (` +
    [q(id), q(email(p.who)), q(p.who), q(p.role), p.seats, q(p.date), q(p.time), q(notes),
     q(p.from), q(p.to), q(REGION[p.from] || "Other"), q(REGION[p.to] || "Other"),
     created, created].join(", ") + ");"
  );

  const joiners = p.role === "driver" ? (p.takers || []).slice(0, p.seats) : (p.plus || []);
  joiners.forEach((n) => {
    out.push(
      `INSERT INTO plus_ones (post_id, author_email, author_name, created_at) VALUES (` +
      [q(id), q(email(n)), q(n), tick()].join(", ") + ");"
    );
  });

  (p.comments || []).forEach(([n, text], j) => {
    out.push(
      `INSERT INTO comments (id, post_id, author_email, author_name, body, created_at) VALUES (` +
      [q(`${id}-c${j}`), q(id), q(email(n)), q(n), q(text), tick()].join(", ") + ");"
    );
  });
});

const drivers = POSTS.filter((p) => p.role === "driver");
out.push(
  `INSERT INTO audit_log (ts, actor_email, actor_name, action, entity_type, detail) VALUES (` +
  [Date.now(), "NULL", q("system"), q("testdata.seed"), q("post"),
   q(JSON.stringify({ posts: POSTS.length, drivers: drivers.length, riders: POSTS.length - drivers.length }))
  ].join(", ") + ");"
);

console.log(out.join("\n"));
console.error(
  `${POSTS.length} posts (${drivers.length} driver / ${POSTS.length - drivers.length} rider), ` +
  `${POSTS.reduce((n, p) => n + ((p.takers || p.plus || []).length), 0)} joins, ` +
  `${POSTS.reduce((n, p) => n + (p.comments || []).length, 0)} comments.`
);
