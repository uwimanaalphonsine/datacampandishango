// The optional AI tutor: personal feedback and hints, reading handwritten
// numbers, and progress notes for grown-ups. Uses Claude through the
// Anthropic SDK; the server only calls these when an API key is configured.

import { HttpError } from "./http-error.js";

export const MODEL = "claude-opus-5-5";

const TUTOR_SYSTEM = `You are "Bibi", a warm, patient maths helper inside a learning game for children aged 4 to 8 who are just starting school.
Rules:
- Use very short, simple sentences (at most 2 sentences, under 30 words). Many children cannot read yet, so the text is read aloud.
- Talk about the real objects in the problem (pens, potatoes, beans, small stones, mangoes, eggs).
- Praise effort and good thinking, never just speed. Never say the child is wrong or bad; say "not yet" or "let's look again".
- When giving a hint, NEVER say the final answer or any number that equals it. Suggest a way to find it: touching and counting, counting on, covering objects, sharing one at a time, or skip-counting groups.
- If the child's answer shows a common mistake (counting one too many, adding instead of taking away, off by one group), gently point the child towards it without naming the answer.`;

const FEEDBACK_SCHEMA = {
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"],
  additionalProperties: false,
};

const DIGITS_SCHEMA = {
  type: "object",
  properties: {
    digits: { type: "string", description: "The number written, digits only, or empty if unreadable" },
    confident: { type: "boolean" },
  },
  required: ["digits", "confident"],
  additionalProperties: false,
};

const REPORT_SCHEMA = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
  additionalProperties: false,
};

// One structured call to Claude. Low effort keeps replies quick so a child is
// never left waiting; the default fallback re-runs a declined request on
// another model instead of returning nothing.
async function askClaude(client, { system, content, schema }) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema } },
    system,
    messages: [{ role: "user", content }],
  });
  if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
    throw new Error(`Claude stopped early: ${response.stop_reason}`);
  }
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(text);
}

// The game decides right and wrong; the AI only chooses the words. A hint that
// gives the answer away is replaced by the game's own hint.
function leaksAnswer(message, problem) {
  const answer = String(problem.answer);
  const givenNumbers = [problem.a, problem.b].map(String);
  if (givenNumbers.includes(answer)) return false;
  return new RegExp(`(^|\\D)${answer}(\\D|$)`).test(message);
}

export async function feedback(client, body) {
  const { problem, childAnswer, status, attempt, childName, recentNote } = body;
  if (!problem || typeof problem.story !== "string" || !Number.isFinite(problem.answer)) {
    throw new HttpError(400, "problem is required");
  }
  const facts = [
    `Child's name: ${String(childName || "friend").slice(0, 30)}`,
    `Topic: ${problem.topic}, level ${problem.level} of 5`,
    `Problem shown: "${problem.story}" (${problem.equation})`,
    `Correct answer (secret, for you only): ${problem.answer}`,
    `Child answered: ${String(childAnswer ?? "").slice(0, 5)}`,
    `Result: ${status === "correct" ? "CORRECT" : "NOT YET"}, try number ${Number(attempt) || 1}`,
    recentNote ? `Recently: ${String(recentNote).slice(0, 200)}` : "",
  ].filter(Boolean).join("\n");
  const task = status === "correct"
    ? "Write a short, specific celebration of how the child solved it."
    : "Write a gentle hint that helps the child find the answer themselves. Do not reveal the answer.";
  const out = await askClaude(client, { system: TUTOR_SYSTEM, content: `${facts}\n\n${task}`, schema: FEEDBACK_SCHEMA });
  const message = String(out.message || "").trim();
  if (!message || (status !== "correct" && leaksAnswer(message, problem))) return { message: null };
  return { message };
}

export async function readDigits(client, body) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.image || ""));
  if (!match) throw new HttpError(400, "image must be a PNG data URL");
  const out = await askClaude(client, {
    system: "You read numbers handwritten by young children on a touch screen. Children's digits are often wobbly, large, or reversed (a backwards 3 or 7 is still 3 or 7).",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: match[1] } },
      { type: "text", text: "What number did the child write? Reply with digits only. If nothing readable is written, reply with an empty string." },
    ],
    schema: DIGITS_SCHEMA,
  });
  const digits = String(out.digits || "").replace(/\D/g, "").slice(0, 3);
  return { digits, confident: Boolean(out.confident) };
}

export async function report(client, body) {
  const name = String(body.name || "The child").slice(0, 30);
  const stats = JSON.stringify(body.stats || {}).slice(0, 4000);
  const out = await askClaude(client, {
    system: "You write short, encouraging progress notes for parents and teachers of young children learning early maths. Plain language, no jargon, 4 to 6 sentences: what is going well, what to practise next, and one simple activity to try at home with everyday objects.",
    content: `Child: ${name}\nProgress by topic (level is 1 to 5; percentages are of problems tried):\n${stats}`,
    schema: REPORT_SCHEMA,
  });
  return { summary: String(out.summary || "") };
}
