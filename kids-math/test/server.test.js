import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server.js";

async function startServer(t, opts = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ishango-"));
  const dataFile = path.join(dir, "db.json");
  const server = await createApp({ dataFile, ...opts });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, dataFile };
}

// A tiny browser: remembers the session cookie between requests.
function browser(base) {
  let cookie = "";
  return async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
    return { status: res.status, data: await res.json().catch(() => null), setCookie: set };
  };
}

const PROGRESS = { version: 1, topics: {}, review: [], stars: 3 };
const SETTINGS = { thinkSeconds: 20, voice: true, ai: false };

test("register, save children's work, log out and log back in", async (t) => {
  const { base, dataFile } = await startServer(t);
  const b = browser(base);

  assert.equal((await b("GET", "/api/me")).status, 401, "must log in first");

  const reg = await b("POST", "/api/register", { name: "Teacher Alice", email: "Alice@School.rw", password: "maths-is-fun" });
  assert.equal(reg.status, 200);
  assert.match(reg.setCookie, /HttpOnly/);
  assert.match(reg.setCookie, /SameSite=Lax/);
  assert.deepEqual(reg.data.user, { name: "Teacher Alice", email: "alice@school.rw" });

  assert.equal((await b("PUT", "/api/children/Keza", { progress: PROGRESS, settings: SETTINGS })).status, 200);
  assert.equal((await b("PUT", "/api/children/Eric", { progress: { ...PROGRESS, stars: 7 }, settings: SETTINGS })).status, 200);

  const me = await b("GET", "/api/me");
  assert.deepEqual(Object.keys(me.data.children).sort(), ["Eric", "Keza"]);
  assert.equal(me.data.children.Eric.progress.stars, 7);

  assert.equal((await b("POST", "/api/logout", {})).status, 200);
  assert.equal((await b("GET", "/api/me")).status, 401, "logged out");

  const again = await b("POST", "/api/login", { email: "alice@school.rw", password: "maths-is-fun" });
  assert.equal(again.status, 200);
  assert.equal(again.data.children.Keza.progress.stars, 3, "work is still there after logging back in");

  // The database keeps no plain passwords or session tokens.
  const raw = await fs.readFile(dataFile, "utf8");
  assert.ok(!raw.includes("maths-is-fun"));
  assert.ok(!raw.includes(again.setCookie.split(";")[0].split("=")[1]));
});

test("work survives a server restart", async (t) => {
  const { base, dataFile } = await startServer(t);
  const b = browser(base);
  await b("POST", "/api/register", { name: "Mum", email: "mum@example.com", password: "12345678" });
  await b("PUT", "/api/children/Neza", { progress: PROGRESS, settings: SETTINGS });

  const restarted = await createApp({ dataFile });
  await new Promise((r) => restarted.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => restarted.close(r)));
  const b2 = browser(`http://127.0.0.1:${restarted.address().port}`);
  const login = await b2("POST", "/api/login", { email: "mum@example.com", password: "12345678" });
  assert.ok(login.data.children.Neza);
});

test("each grown-up sees only their own children", async (t) => {
  const { base } = await startServer(t);
  const a = browser(base);
  const b = browser(base);
  await a("POST", "/api/register", { name: "A", email: "a@example.com", password: "password-a" });
  await b("POST", "/api/register", { name: "B", email: "b@example.com", password: "password-b" });
  await a("PUT", "/api/children/Keza", { progress: PROGRESS, settings: SETTINGS });
  assert.deepEqual((await b("GET", "/api/me")).data.children, {});
});

test("registration and login are checked", async (t) => {
  const { base } = await startServer(t);
  const b = browser(base);
  assert.equal((await b("POST", "/api/register", { name: "X", email: "not-an-email", password: "12345678" })).status, 400);
  assert.equal((await b("POST", "/api/register", { name: "X", email: "x@example.com", password: "short" })).status, 400);
  assert.equal((await b("POST", "/api/register", { name: "", email: "x@example.com", password: "12345678" })).status, 400);
  assert.equal((await b("POST", "/api/register", { name: "X", email: "x@example.com", password: "12345678" })).status, 200);
  assert.equal((await b("POST", "/api/register", { name: "X", email: "X@example.com", password: "12345678" })).status, 409, "email already used");

  const other = browser(base);
  const wrong = await other("POST", "/api/login", { email: "x@example.com", password: "wrong-password" });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.data.error, "That email or password is not right.");
  const unknown = await other("POST", "/api/login", { email: "nobody@example.com", password: "12345678" });
  assert.equal(unknown.data.error, wrong.data.error, "does not reveal which emails have accounts");
});

test("repeated wrong passwords are slowed down", async (t) => {
  const { base } = await startServer(t);
  const b = browser(base);
  await b("POST", "/api/register", { name: "X", email: "x@example.com", password: "12345678" });
  let last;
  for (let i = 0; i < 9; i++) last = await browser(base)("POST", "/api/login", { email: "x@example.com", password: "guess" + i });
  assert.equal(last.status, 429);
});

test("children's names and saved work are validated", async (t) => {
  const { base } = await startServer(t);
  const b = browser(base);
  await b("POST", "/api/register", { name: "X", email: "x@example.com", password: "12345678" });
  assert.equal((await b("PUT", "/api/children/__proto__", { progress: PROGRESS, settings: SETTINGS })).status, 400);
  assert.equal((await b("PUT", `/api/children/${"a".repeat(21)}`, { progress: PROGRESS, settings: SETTINGS })).status, 400);
  assert.equal((await b("PUT", "/api/children/Keza", { progress: "nope", settings: SETTINGS })).status, 400);
  assert.equal((await b("PUT", `/api/children/${encodeURIComponent("Ange Marie")}`, { progress: PROGRESS, settings: SETTINGS })).status, 200);
  assert.equal((await b("DELETE", `/api/children/${encodeURIComponent("Ange Marie")}`)).status, 415, "writes must be JSON");
  assert.equal((await b("DELETE", `/api/children/${encodeURIComponent("Ange Marie")}`, {})).status, 200);
  assert.deepEqual((await b("GET", "/api/me")).data.children, {});
});

test("other websites cannot act as a logged-in grown-up", async (t) => {
  const { base } = await startServer(t);
  const b = browser(base);
  await b("POST", "/api/register", { name: "X", email: "x@example.com", password: "12345678" });
  const res = await b("PUT", "/api/children/Keza", { progress: PROGRESS, settings: SETTINGS }, { origin: "https://evil.example" });
  assert.equal(res.status, 403);
});

test("the AI tutor needs a logged-in grown-up", async (t) => {
  const fakeClient = { beta: { messages: { create: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: '{"message":"Great counting!"}' }] }) } } };
  const { base } = await startServer(t, { aiClient: fakeClient });
  const b = browser(base);
  const problem = { topic: "add", level: 1, story: "x", equation: "1 + 2 = ?", answer: 3, a: 1, b: 2 };
  assert.equal((await b("POST", "/api/feedback", { problem, childAnswer: "3", status: "correct" })).status, 401);
  await b("POST", "/api/register", { name: "X", email: "x@example.com", password: "12345678" });
  const ok = await b("POST", "/api/feedback", { problem, childAnswer: "3", status: "correct" });
  assert.equal(ok.data.message, "Great counting!");
  assert.deepEqual((await (await fetch(base + "/api/status")).json()), { ai: true, accounts: true });
});
