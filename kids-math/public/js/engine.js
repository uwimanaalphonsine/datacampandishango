// Core learning engine: builds everyday-life maths problems and adapts the
// difficulty to each child. Pure logic with no DOM access, so it runs in the
// browser and under `node --test`.

export const TOPICS = ["count", "add", "sub", "mul", "div"];

export const TOPIC_INFO = {
  count: { title: "Counting", symbol: "123", unlock: null },
  add: { title: "Adding", symbol: "+", unlock: { topic: "count", level: 2 } },
  sub: { title: "Taking away", symbol: "−", unlock: { topic: "add", level: 2 } },
  mul: { title: "Groups of", symbol: "×", unlock: { topic: "add", level: 3 } },
  div: { title: "Sharing", symbol: "÷", unlock: { topic: "mul", level: 2 } },
};

export const MAX_LEVEL = 5;

// Everyday objects a child can find at home or at school.
export const OBJECTS = [
  { id: "pen", one: "pen", many: "pens" },
  { id: "potato", one: "potato", many: "potatoes" },
  { id: "bean", one: "bean", many: "beans" },
  { id: "stone", one: "small stone", many: "small stones" },
  { id: "mango", one: "mango", many: "mangoes" },
  { id: "egg", one: "egg", many: "eggs" },
];

const NAMES = ["Amina", "Keza", "Eric", "Aline", "Mugisha", "Grace", "David", "Ishimwe", "Neza", "Jean"];
const CONTAINERS = ["baskets", "bags", "bowls", "boxes"];

// Number ranges per topic and level. Level 1 is a child's very first day.
const RANGES = {
  count: [[1, 5], [1, 10], [5, 15], [10, 20], [15, 30]],
  add: [5, 10, 15, 20, 30], // largest total
  sub: [5, 10, 15, 20, 30], // largest starting amount
  mul: [ // [groups min, groups max, per-group min, per-group max]
    [2, 2, 1, 3], [2, 3, 1, 4], [2, 5, 1, 5], [2, 5, 2, 8], [2, 6, 2, 10],
  ],
  div: [ // [people min, people max, each-gets min, each-gets max]
    [2, 2, 1, 3], [2, 3, 1, 4], [2, 4, 1, 5], [2, 5, 2, 6], [2, 6, 2, 8],
  ],
};

export function randInt(min, max, rng = Math.random) {
  return min + Math.floor(rng() * (max - min + 1));
}

function pick(list, rng) {
  return list[Math.floor(rng() * list.length)];
}

function plural(obj, n) {
  return n === 1 ? obj.one : obj.many;
}

function clampLevel(level) {
  return Math.max(1, Math.min(MAX_LEVEL, level));
}

// Builds one problem. Every problem carries a `visual` description that the
// UI turns into pictures, so children can solve it by looking and counting.
export function makeProblem(topic, level, rng = Math.random, avoidKey = null) {
  for (let tries = 0; tries < 20; tries++) {
    const p = buildProblem(topic, clampLevel(level), rng);
    if (p.key !== avoidKey) return p;
  }
  return buildProblem(topic, clampLevel(level), rng);
}

// `fixed` ({ a, b }) rebuilds a known problem with new objects and names.
function buildProblem(topic, level, rng, fixed = null) {
  const obj = pick(OBJECTS, rng);
  const name = pick(NAMES, rng);
  let a, b, answer, story, equation, visual, hint;

  switch (topic) {
    case "count": {
      const [lo, hi] = RANGES.count[level - 1];
      a = fixed ? fixed.a : randInt(lo, hi, rng);
      b = 0;
      answer = a;
      story = `How many ${obj.many} can you count?`;
      equation = "?";
      visual = { kind: "count", groups: [a] };
      hint = `Touch each ${obj.one} as you count it: one, two, three…`;
      break;
    }
    case "add": {
      const max = RANGES.add[level - 1];
      const total = fixed ? fixed.a + fixed.b : randInt(2, max, rng);
      a = fixed ? fixed.a : randInt(1, total - 1, rng);
      b = total - a;
      answer = total;
      story = `${name} has ${a} ${plural(obj, a)}. A friend gives ${name} ${b} more. How many ${obj.many} does ${name} have now?`;
      equation = `${a} + ${b} = ?`;
      visual = { kind: "add", groups: [a, b] };
      hint = `Count the first group, then keep counting the new ${obj.many}.`;
      break;
    }
    case "sub": {
      const max = RANGES.sub[level - 1];
      a = fixed ? fixed.a : randInt(2, max, rng);
      b = fixed ? fixed.b : randInt(1, a - 1, rng);
      answer = a - b;
      story = `${name} has ${a} ${plural(obj, a)}. ${name} gives away ${b}. How many ${obj.many} are left?`;
      equation = `${a} − ${b} = ?`;
      visual = { kind: "sub", groups: [a], remove: b };
      hint = `Cover the ${b} that go away, then count the ${obj.many} that stay.`;
      break;
    }
    case "mul": {
      const [gMin, gMax, eMin, eMax] = RANGES.mul[level - 1];
      a = fixed ? fixed.a : randInt(gMin, gMax, rng); // number of groups
      b = fixed ? fixed.b : randInt(eMin, eMax, rng); // items in each group
      answer = a * b;
      const box = pick(CONTAINERS, rng);
      story = `There are ${a} ${box}. Each one has ${b} ${plural(obj, b)}. How many ${obj.many} are there altogether?`;
      equation = `${a} × ${b} = ?`;
      visual = { kind: "mul", groups: Array(a).fill(b) };
      hint = `Count ${b} in each group: skip-count ${b}, ${b * 2}…`;
      break;
    }
    case "div": {
      const [pMin, pMax, eMin, eMax] = RANGES.div[level - 1];
      b = fixed ? fixed.b : randInt(pMin, pMax, rng); // number of children sharing
      answer = fixed ? fixed.a / fixed.b : randInt(eMin, eMax, rng); // how many each child gets
      a = b * answer;
      story = `${name} has ${a} ${plural(obj, a)} to share equally between ${b} children. How many ${obj.many} does each child get?`;
      equation = `${a} ÷ ${b} = ?`;
      visual = { kind: "div", groups: [a], share: b };
      hint = `Give one ${obj.one} to each child, again and again, until none are left.`;
      break;
    }
    default:
      throw new Error(`Unknown topic: ${topic}`);
  }

  return {
    topic, level, a, b, answer, story, equation, hint, visual,
    object: obj.id, objectName: { one: obj.one, many: obj.many },
    key: `${topic}:${a}:${b}`,
  };
}

// ---------------------------------------------------------------------------
// Answer checking

// Children type or write digits; anything else (empty, letters) is "not a
// number yet" rather than a wrong answer.
export function parseAnswer(text) {
  const t = String(text ?? "").trim();
  if (!/^\d{1,3}$/.test(t)) return null;
  return Number(t);
}

export function checkAnswer(problem, text) {
  const value = parseAnswer(text);
  if (value === null) return { status: "invalid" };
  return { status: value === problem.answer ? "correct" : "wrong", value };
}

// ---------------------------------------------------------------------------
// Adaptive progress

export function newProgress() {
  const topics = {};
  for (const t of TOPICS) {
    topics[t] = { level: 1, streak: 0, struggles: 0, solved: 0, attempted: 0, firstTry: 0, history: [] };
  }
  return { version: 1, topics, review: [], stars: 0 };
}

// Fills in anything missing from progress saved by an older version.
export function normalizeProgress(saved) {
  const fresh = newProgress();
  if (!saved || typeof saved !== "object" || !saved.topics) return fresh;
  for (const t of TOPICS) {
    fresh.topics[t] = { ...fresh.topics[t], ...(saved.topics[t] || {}) };
    fresh.topics[t].level = clampLevel(fresh.topics[t].level);
  }
  fresh.review = Array.isArray(saved.review) ? saved.review.slice(-10) : [];
  fresh.stars = Number(saved.stars) || 0;
  return fresh;
}

export function isUnlocked(progress, topic) {
  const rule = TOPIC_INFO[topic].unlock;
  return !rule || progress.topics[rule.topic].level >= rule.level;
}

// Records the outcome of one problem and adjusts that topic's level.
//   solved:   the child reached the right answer (possibly after a retry)
//   attempts: how many answers they checked
//   helped:   they used a hint or "show me how"
// Returns { levelChange: -1 | 0 | 1 } so the UI can celebrate or reassure.
export function recordResult(progress, problem, { solved, attempts, helped, seconds }) {
  const s = progress.topics[problem.topic];
  const firstTry = solved && attempts === 1 && !helped;
  s.attempted += 1;
  if (solved) s.solved += 1;
  if (firstTry) s.firstTry += 1;
  s.history = [...s.history, { level: problem.level, solved, firstTry, attempts, seconds: Math.round(seconds || 0) }].slice(-20);

  let levelChange = 0;
  if (firstTry) {
    s.streak += 1;
    s.struggles = 0;
    progress.stars += 1;
  } else {
    s.streak = 0;
    if (solved) progress.stars += 0.5;
    else s.struggles += 1;
  }

  // Move up after three confident answers in a row at this level.
  if (s.streak >= 3 && s.level < MAX_LEVEL) {
    s.level += 1;
    s.streak = 0;
    levelChange = 1;
  }
  // Ease off after two problems that the child could not solve, with no
  // confident answer in between.
  if (s.struggles >= 2 && s.level > 1) {
    s.level -= 1;
    s.struggles = 0;
    levelChange = -1;
  }

  // Problems the child found hard come back later for another go.
  if (!firstTry) {
    progress.review = [...progress.review.filter((r) => r.key !== problem.key), {
      topic: problem.topic, level: problem.level, a: problem.a, b: problem.b, key: problem.key,
    }].slice(-10);
  } else {
    progress.review = progress.review.filter((r) => r.key !== problem.key);
  }

  return { levelChange };
}

// Chooses the next problem for a topic: usually a fresh one at the child's
// level, sometimes a revisit of an earlier tricky one (with new objects).
export function nextProblem(progress, topic, rng = Math.random, lastKey = null) {
  const level = progress.topics[topic].level;
  const reviews = progress.review.filter((r) => r.topic === topic && r.key !== lastKey);
  if (reviews.length && rng() < 0.3) {
    const r = reviews[0];
    return { ...buildProblem(topic, clampLevel(r.level), rng, { a: r.a, b: r.b }), review: true };
  }
  return makeProblem(topic, level, rng, lastKey);
}

// Short numbers summarising a child's work, used for the progress screen and
// for the AI report for parents and teachers.
export function summarize(progress) {
  const out = {};
  for (const t of TOPICS) {
    const s = progress.topics[t];
    const recent = s.history.slice(-10);
    out[t] = {
      title: TOPIC_INFO[t].title,
      level: s.level,
      attempted: s.attempted,
      solvedPercent: s.attempted ? Math.round((100 * s.solved) / s.attempted) : null,
      recentFirstTryPercent: recent.length ? Math.round((100 * recent.filter((h) => h.firstTry).length) / recent.length) : null,
      recentAvgSeconds: recent.length ? Math.round(recent.reduce((n, h) => n + h.seconds, 0) / recent.length) : null,
      unlocked: isUnlocked(progress, t),
    };
  }
  return out;
}
