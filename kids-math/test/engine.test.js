import test from "node:test";
import assert from "node:assert/strict";
import {
  TOPICS, MAX_LEVEL, makeProblem, checkAnswer, newProgress, normalizeProgress,
  recordResult, nextProblem, isUnlocked, summarize,
} from "../public/js/engine.js";

// Small seeded random generator so tests are repeatable.
function seeded(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

test("every topic and level makes sensible problems", () => {
  const rng = seeded(1);
  for (const topic of TOPICS) {
    for (let level = 1; level <= MAX_LEVEL; level++) {
      for (let i = 0; i < 200; i++) {
        const p = makeProblem(topic, level, rng);
        assert.ok(Number.isInteger(p.answer) && p.answer >= 0, `${topic} ${level} answer ${p.answer}`);
        assert.ok(p.story.length > 0 && p.hint.length > 0);
        const expected = { count: p.a, add: p.a + p.b, sub: p.a - p.b, mul: p.a * p.b, div: p.a / p.b }[topic];
        assert.equal(p.answer, expected);
        if (topic === "sub") assert.ok(p.answer >= 1, "always something left");
        if (topic === "div") assert.equal(p.a % p.b, 0, "shares equally");
        const shown = p.visual.groups.reduce((n, g) => n + g, 0);
        assert.ok(shown >= 1 && shown <= 60, `${topic} ${level} shows ${shown} objects`);
      }
    }
  }
});

test("first level stays tiny for beginners", () => {
  const rng = seeded(2);
  for (let i = 0; i < 200; i++) {
    assert.ok(makeProblem("count", 1, rng).answer <= 5);
    assert.ok(makeProblem("add", 1, rng).answer <= 5);
    assert.ok(makeProblem("sub", 1, rng).a <= 5);
  }
});

test("answers are checked as whole numbers", () => {
  const p = makeProblem("add", 1, seeded(3));
  assert.equal(checkAnswer(p, String(p.answer)).status, "correct");
  assert.equal(checkAnswer(p, ` ${p.answer} `).status, "correct");
  assert.equal(checkAnswer(p, String(p.answer + 1)).status, "wrong");
  assert.equal(checkAnswer(p, "").status, "invalid");
  assert.equal(checkAnswer(p, "abc").status, "invalid");
  assert.equal(checkAnswer(p, "1.5").status, "invalid");
});

test("three confident answers move a child up a level", () => {
  const prog = newProgress();
  const p = makeProblem("count", 1, seeded(4));
  let change = 0;
  for (let i = 0; i < 3; i++) change = recordResult(prog, p, { solved: true, attempts: 1, helped: false, seconds: 5 }).levelChange;
  assert.equal(change, 1);
  assert.equal(prog.topics.count.level, 2);
  assert.equal(prog.topics.count.streak, 0);
});

test("help or retries do not count towards levelling up", () => {
  const prog = newProgress();
  const p = makeProblem("count", 1, seeded(5));
  recordResult(prog, p, { solved: true, attempts: 1, helped: false });
  recordResult(prog, p, { solved: true, attempts: 2, helped: false });
  recordResult(prog, p, { solved: true, attempts: 1, helped: true });
  assert.equal(prog.topics.count.level, 1);
});

test("two unsolved problems ease the level down, never below 1", () => {
  const prog = newProgress();
  prog.topics.add.level = 3;
  const p = makeProblem("add", 3, seeded(6));
  recordResult(prog, p, { solved: false, attempts: 3, helped: true });
  const { levelChange } = recordResult(prog, p, { solved: false, attempts: 3, helped: true });
  assert.equal(levelChange, -1);
  assert.equal(prog.topics.add.level, 2);

  prog.topics.count.level = 1;
  const q = makeProblem("count", 1, seeded(7));
  recordResult(prog, q, { solved: false, attempts: 3, helped: true });
  recordResult(prog, q, { solved: false, attempts: 3, helped: true });
  assert.equal(prog.topics.count.level, 1);
});

test("tricky problems come back for review with the same numbers", () => {
  const prog = newProgress();
  const p = makeProblem("sub", 5, seeded(8));
  recordResult(prog, p, { solved: false, attempts: 3, helped: true });
  assert.equal(prog.review.length, 1);
  const again = nextProblem(prog, "sub", () => 0); // rng 0 always picks review
  assert.equal(again.review, true);
  assert.equal(again.a, p.a);
  assert.equal(again.b, p.b);
  assert.equal(again.answer, p.answer);
  recordResult(prog, again, { solved: true, attempts: 1, helped: false });
  assert.equal(prog.review.length, 0, "solved confidently, so it leaves the review list");
});

test("review rebuilds division problems correctly", () => {
  const prog = newProgress();
  const p = makeProblem("div", 4, seeded(9));
  recordResult(prog, p, { solved: false, attempts: 3, helped: true });
  const again = nextProblem(prog, "div", () => 0);
  assert.equal(again.answer, p.answer);
  assert.equal(again.a, p.a);
});

test("topics unlock step by step", () => {
  const prog = newProgress();
  assert.ok(isUnlocked(prog, "count"));
  assert.ok(!isUnlocked(prog, "add"));
  prog.topics.count.level = 2;
  assert.ok(isUnlocked(prog, "add"));
  assert.ok(!isUnlocked(prog, "mul"));
  prog.topics.add.level = 3;
  assert.ok(isUnlocked(prog, "sub") && isUnlocked(prog, "mul"));
  assert.ok(!isUnlocked(prog, "div"));
});

test("old or broken saved progress is repaired", () => {
  const fixed = normalizeProgress({ topics: { count: { level: 99 } }, stars: "x" });
  assert.equal(fixed.topics.count.level, MAX_LEVEL);
  assert.equal(fixed.topics.div.level, 1);
  assert.equal(fixed.stars, 0);
  assert.deepEqual(normalizeProgress(null), newProgress());
});

test("summary reports percentages per topic", () => {
  const prog = newProgress();
  const p = makeProblem("count", 1, seeded(10));
  recordResult(prog, p, { solved: true, attempts: 1, helped: false, seconds: 4 });
  recordResult(prog, p, { solved: false, attempts: 3, helped: true, seconds: 10 });
  const s = summarize(prog);
  assert.equal(s.count.attempted, 2);
  assert.equal(s.count.solvedPercent, 50);
  assert.equal(s.count.recentAvgSeconds, 7);
  assert.equal(s.add.solvedPercent, null);
});
