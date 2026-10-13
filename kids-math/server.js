// Serves the app and the optional AI tutor endpoints.
//
//   npm start                      -> http://localhost:3000
//   ANTHROPIC_API_KEY=... npm start -> same, with the AI tutor switched on
//
// The browser never sees the API key: it talks to this server, which talks to
// Claude. Everything still works without a key, using built-in feedback.

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "public");
const PORT = Number(process.env.PORT) || 3000;
const MODEL = "claude-opus-5-5";
const MAX_BODY = 1_500_000; // handwriting images are small PNGs

const aiEnabled = process.env.KIDS_MATH_AI !== "off" &&
  Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
const client = aiEnabled ? new Anthropic() : null;

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
async function askClaude({ system, content, schema }) {
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

async function feedback(body) {
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
  const out = await askClaude({ system: TUTOR_SYSTEM, content: `${facts}\n\n${task}`, schema: FEEDBACK_SCHEMA });
  const message = String(out.message || "").trim();
  if (!message || (status !== "correct" && leaksAnswer(message, problem))) return { message: null };
  return { message };
}

async function readDigits(body) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.image || ""));
  if (!match) throw new HttpError(400, "image must be a PNG data URL");
  const out = await askClaude({
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

async function report(body) {
  const name = String(body.name || "The child").slice(0, 30);
  const stats = JSON.stringify(body.stats || {}).slice(0, 4000);
  const out = await askClaude({
    system: "You write short, encouraging progress notes for parents and teachers of young children learning early maths. Plain language, no jargon, 4 to 6 sentences: what is going well, what to practise next, and one simple activity to try at home with everyday objects.",
    content: `Child: ${name}\nProgress by topic (level is 1 to 5; percentages are of problems tried):\n${stats}`,
    schema: REPORT_SCHEMA,
  });
  return { summary: String(out.summary || "") };
}

// ---------------------------------------------------------------------------
// HTTP plumbing

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const ROUTES = { "/api/feedback": feedback, "/api/read-digits": readDigits, "/api/report": report };

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json",
  ".png": "image/png", ".ico": "image/x-icon",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, "body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new HttpError(400, "invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: "forbidden" });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "not found" });
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (pathname === "/api/status") return sendJson(res, 200, { ai: aiEnabled });
  const handler = ROUTES[pathname];
  if (!handler) return req.method === "GET" ? serveStatic(req, res, pathname) : sendJson(res, 404, { error: "not found" });
  if (req.method !== "POST") return sendJson(res, 405, { error: "use POST" });
  if (!aiEnabled) return sendJson(res, 503, { error: "AI tutor is not configured" });
  try {
    sendJson(res, 200, await handler(await readBody(req)));
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    if (err instanceof Anthropic.RateLimitError) return sendJson(res, 429, { error: "AI tutor is busy" });
    console.error("AI request failed:", err.message);
    sendJson(res, 502, { error: "AI tutor unavailable" });
  }
});

server.listen(PORT, () => {
  console.log(`Ishango Maths is running at http://localhost:${PORT}`);
  console.log(aiEnabled ? `AI tutor: on (${MODEL})` : "AI tutor: off (set ANTHROPIC_API_KEY to switch it on)");
});
