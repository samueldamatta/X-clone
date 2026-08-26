/**
 * Scene 2 — hybrid fan-out, the decision the whole timeline design turns on.
 *
 * The layout is the argument: two write paths side by side, deliberately
 * identical until the Fanout Worker, where a single follower-count check sends
 * them apart. Each column then drops STRAIGHT DOWN into the read source it
 * produced, so the reader can see that "precomputed" and "computed on read" are
 * two halves of one timeline rather than two competing designs.
 */

const COL_L = 380; // centre of the normal-author column
const COL_R = 1100; // centre of the celebrity column

/** A box centred on one of the two columns. */
const at = (cx, y, w, h) => ({ x: cx - w / 2, y, w, h });

export default {
  name: '02-hybrid-fanout',
  title: 'X-clone — Hybrid Fan-out',
  subtitle:
    'Precompute the timeline for ordinary authors, compute it on read for celebrities — and merge both at request time',
  width: 1480,
  height: 1240,

  frames: [
    {
      label: 'Fan-out on write — author under 10k followers (~99.9% of accounts)',
      x: 60,
      y: 130,
      w: 640,
      h: 490,
    },
    {
      label: 'No fan-out — author over 10k followers (the "celebrity problem")',
      x: 780,
      y: 130,
      w: 640,
      h: 490,
    },
    {
      label: 'Read path — GET /timeline/home',
      x: 60,
      y: 720,
      w: 1360,
      h: 400,
    },
  ],

  nodes: [
    // --- Left: the ordinary author ------------------------------------------
    { id: 'l1', kind: 'client', ...at(COL_L, 150, 300, 56), label: '@alice tweets', sub: '180 followers' },
    { id: 'l2', kind: 'serviceTs', ...at(COL_L, 250, 300, 56), label: 'Tweet Service', sub: 'persist + outbox row' },
    { id: 'l3', kind: 'broker', ...at(COL_L, 350, 300, 46), label: 'Kafka · tweet.created' },
    {
      id: 'l4',
      kind: 'serviceGo',
      ...at(COL_L, 440, 300, 56),
      label: 'Fanout Worker',
      sub: 'followers ≤ 10k → PUSH',
    },
    {
      id: 'l5',
      kind: 'store',
      ...at(COL_L, 540, 300, 64),
      label: 'Redis · 180 LPUSH',
      sub: 'user:{follower}:home · capped 800',
    },

    // --- Right: the celebrity ------------------------------------------------
    { id: 'r1', kind: 'client', ...at(COL_R, 150, 300, 56), label: '@celebrity tweets', sub: '40M followers' },
    { id: 'r2', kind: 'serviceTs', ...at(COL_R, 250, 300, 56), label: 'Tweet Service', sub: 'persist + outbox row' },
    { id: 'r3', kind: 'broker', ...at(COL_R, 350, 300, 46), label: 'Kafka · tweet.created' },
    {
      id: 'r4',
      kind: 'serviceGo',
      ...at(COL_R, 440, 300, 56),
      label: 'Fanout Worker',
      sub: 'followers > 10k → SKIP',
    },
    {
      id: 'r5',
      kind: 'store',
      ...at(COL_R, 540, 300, 64),
      label: 'Redis · 1 LPUSH',
      sub: 'author:{id}:tweets',
    },

    // --- Read path -----------------------------------------------------------
    {
      id: 'rHot',
      kind: 'store',
      ...at(COL_L, 760, 300, 64),
      label: 'LRANGE user:{id}:home',
      sub: 'precomputed · 0..49 · ~0.2ms',
    },
    {
      id: 'rCeleb',
      kind: 'store',
      ...at(COL_R, 760, 300, 64),
      label: 'LRANGE author:{c}:tweets',
      sub: '× the 5–20 celebrities followed',
    },
    {
      id: 'rMerge',
      kind: 'serviceGo',
      ...at(740, 890, 390, 64),
      label: 'merge-sort, take newest 50',
      sub: 'Snowflake ID order == time order',
    },
    {
      id: 'rHyd',
      kind: 'serviceGo',
      ...at(740, 1000, 390, 64),
      label: 'hydrate: MGET tweet bodies',
      sub: 'one batch · cache-aside · IDs → objects',
    },
  ],

  edges: [
    { from: 'l1', to: 'l2' },
    { from: 'l2', to: 'l3', label: 'publish' },
    { from: 'l3', to: 'l4', label: 'consume' },
    { from: 'l4', to: 'l5', accent: true, label: '180 writes' },

    { from: 'r1', to: 'r2' },
    { from: 'r2', to: 'r3', label: 'publish' },
    { from: 'r3', to: 'r4', label: 'consume' },
    { from: 'r4', to: 'r5', label: '1 write' },

    { from: 'l5', to: 'rHot', accent: true, label: 'written ahead of time' },
    { from: 'r5', to: 'rCeleb', accent: true, label: 'read at request time' },

    { from: 'rHot', to: 'rMerge' },
    { from: 'rCeleb', to: 'rMerge' },
    { from: 'rMerge', to: 'rHyd' },
  ],

  notes: [
    {
      // Sits in the empty channel between the two columns, level with the Fanout
      // Worker boxes — the note is the punchline, so it belongs at the fork.
      x: 740,
      y: 404,
      align: 'center',
      size: 13,
      tone: 'accent',
      text:
        'Same author action.\nSame topic. Same worker.\n\nThe two paths diverge on\nONE follower-count check —\nand that single branch is\nwhat stops a 40M-follower\naccount from issuing 40M\nRedis writes per tweet.',
    },
    {
      x: 740,
      y: 1140,
      align: 'center',
      size: 12.5,
      text:
        'Why it balances: you follow thousands of ordinary accounts but only a handful of celebrities, so the read-side merge stays small —\nwhile celebrities are rare, so skipping their fan-out removes most of the write cost. The two asymmetries cancel out.\n\nWhat it costs: two code paths to keep consistent, and an explicit backfill when an account crosses the 10k threshold in either direction.',
    },
  ],
};
