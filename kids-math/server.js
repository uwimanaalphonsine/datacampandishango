// Serves the app, grown-ups' accounts, children's saved work, and the
// optional AI tutor.
//
//   npm start                       -> http://localhost:3000
//   ANTHROPIC_API_KEY=... npm start -> same, with the AI tutor switched on
//
// A parent or teacher registers and logs in; each child is a profile inside
// that account, and every child's progress is saved on this server (in
// data/db.json by default). The browser never sees the API key.

import http from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { Store } from "./lib/store.js";
import { HttpError } from "./lib/http-error.js";
import {
  hashPassword, verifyPassword, createSession, sessionUser, endSession,
  readCookie, sessionCookie, COOKIE_NAME, LoginLimiter,
} from "./lib/auth.js";
import { MODEL, feedback, readDigits, report } from "./lib/tutor.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "public");
const MAX_BODY = 1_500_000; // handwriting images are small PNGs
const MAX_CHILDREN = 40;
const MAX_CHILD_DATA = 100_000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CHILD_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} '.-]{0,19}$/u;

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json",
  ".png": "image/png", ".ico": "image/x-icon",
};

export async function createApp({ dataFile, aiClient = null, secureCookies = false }) {
  const store = await new Store(dataFile).load();
  const limiter = new LoginLimiter();
  // Used when an email is unknown, so a failed login takes the same time
  // whether or not the account exists.
  const dummyHash = await hashPassword("not-a-real-password");

  const publicUser = (u) => ({ name: u.name, email: u.email });

  function setSession(req, res, token) {
    const secure = secureCookies || req.headers["x-forwarded-proto"] === "https";
    res.setHeader("set-cookie", sessionCookie(token, { secure }));
  }

  function requireUser(req) {
    const user = sessionUser(store, readCookie(req, COOKIE_NAME));
    if (!user) throw new HttpError(401, "Please log in.");
    return user;
  }

  function childName(raw) {
    const name = decodeURIComponent(raw).trim();
    if (!CHILD_NAME_RE.test(name)) throw new HttpError(400, "A child's name can have letters, numbers and spaces, up to 20 characters.");
    return name;
  }

  // --- Accounts --------------------------------------------------------------

  async function register(req, res, body) {
    const name = String(body.name || "").trim().slice(0, 40);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!name) throw new HttpError(400, "Please type your name.");
    if (!EMAIL_RE.test(email) || email.length > 120) throw new HttpError(400, "Please type a valid email address.");
    if (password.length < 8 || password.length > 200) throw new HttpError(400, "The password needs at least 8 characters.");
    if (store.findUserByEmail(email)) throw new HttpError(409, "An account with this email already exists. Please log in.");
    const user = {
      id: randomUUID(), name, email, passwordHash: await hashPassword(password),
      createdAt: new Date().toISOString(), children: {},
    };
    // Checked again after the slow hash, in case of two quick sign-ups.
    if (store.findUserByEmail(email)) throw new HttpError(409, "An account with this email already exists. Please log in.");
    store.data.users[user.id] = user;
    const token = createSession(store, user.id);
    await store.save();
    setSession(req, res, token);
    return { user: publicUser(user), children: {} };
  }

  async function login(req, res, body) {
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const key = `${req.socket.remoteAddress}|${email}`;
    if (limiter.blocked(key)) throw new HttpError(429, "Too many tries. Please wait 15 minutes and try again.");
    const user = store.findUserByEmail(email);
    const ok = await verifyPassword(password, user ? user.passwordHash : dummyHash);
    if (!user || !ok) {
      limiter.fail(key);
      throw new HttpError(401, "That email or password is not right.");
    }
    limiter.clear(key);
    const token = createSession(store, user.id);
    await store.save();
    setSession(req, res, token);
    return { user: publicUser(user), children: user.children };
  }

  async function logout(req, res) {
    endSession(store, readCookie(req, COOKIE_NAME));
    await store.save();
    setSession(req, res, "");
    return { ok: true };
  }

  function me(req) {
    const user = requireUser(req);
    return { user: publicUser(user), children: user.children };
  }

  // --- Children's work -------------------------------------------------------

  async function saveChild(req, res, body, rawName) {
    const user = requireUser(req);
    const name = childName(rawName);
    const isNew = !Object.hasOwn(user.children, name);
    if (isNew && Object.keys(user.children).length >= MAX_CHILDREN) {
      throw new HttpError(400, `An account can have up to ${MAX_CHILDREN} children.`);
    }
    const { progress, settings } = body;
    if (typeof progress !== "object" || progress === null || typeof settings !== "object" || settings === null) {
      throw new HttpError(400, "progress and settings are required.");
    }
    if (JSON.stringify({ progress, settings }).length > MAX_CHILD_DATA) throw new HttpError(413, "Saved work is too large.");
    user.children[name] = { progress, settings, updatedAt: new Date().toISOString() };
    await store.save();
    return { ok: true };
  }

  async function deleteChild(req, res, body, rawName) {
    const user = requireUser(req);
    delete user.children[childName(rawName)];
    await store.save();
    return { ok: true };
  }

  // --- AI tutor (logged-in users only, so the API key cannot be misused) -----

  const aiRoute = (fn) => async (req, res, body) => {
    requireUser(req);
    if (!aiClient) throw new HttpError(503, "The AI tutor is not set up on this server.");
    try {
      return await fn(aiClient, body);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (err instanceof Anthropic.RateLimitError) throw new HttpError(429, "The AI tutor is busy. Try again soon.");
      console.error("AI request failed:", err.message);
      throw new HttpError(502, "The AI tutor is not available right now.");
    }
  };

  const ROUTES = {
    "POST /api/register": register,
    "POST /api/login": login,
    "POST /api/logout": logout,
    "GET /api/me": me,
    "PUT /api/children/:name": saveChild,
    "DELETE /api/children/:name": deleteChild,
    "POST /api/feedback": aiRoute(feedback),
    "POST /api/read-digits": aiRoute(readDigits),
    "POST /api/report": aiRoute(report),
  };

  function findRoute(method, pathname) {
    if (ROUTES[`${method} ${pathname}`]) return [ROUTES[`${method} ${pathname}`], []];
    const m = /^\/api\/children\/([^/]+)$/.exec(pathname);
    if (m && ROUTES[`${method} /api/children/:name`]) return [ROUTES[`${method} /api/children/:name`], [m[1]]];
    return [null, []];
  }

  // Requests that change data must be same-site JSON. Browsers will not send
  // a cross-site JSON request with cookies without permission, which blocks
  // other websites from acting as a logged-in grown-up.
  function checkWriteRequest(req) {
    if (req.method === "GET") return;
    if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
      throw new HttpError(415, "Send JSON.");
    }
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, "Cross-site request refused.");
  }

  return http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname === "/api/status") return sendJson(res, 200, { ai: Boolean(aiClient), accounts: true });
    if (!pathname.startsWith("/api/")) {
      return req.method === "GET" ? serveStatic(res, pathname) : sendJson(res, 405, { error: "Method not allowed." });
    }
    const [handler, params] = findRoute(req.method, pathname);
    if (!handler) return sendJson(res, 404, { error: "Not found." });
    try {
      checkWriteRequest(req);
      const body = req.method === "GET" ? {} : await readBody(req);
      sendJson(res, 200, await handler(req, res, body, ...params));
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      console.error(`${req.method} ${pathname} failed:`, err);
      sendJson(res, 500, { error: "Something went wrong. Please try again." });
    }
  });
}

// ---------------------------------------------------------------------------
// HTTP helpers

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, "Request too large.")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        resolve(body && typeof body === "object" ? body : {});
      } catch {
        reject(new HttpError(400, "Invalid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

async function serveStatic(res, pathname) {
  let rel;
  try {
    rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    return sendJson(res, 400, { error: "Bad path." });
  }
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: "Forbidden." });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "Not found." });
  }
}

// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 3000;
  const aiOn = process.env.KIDS_MATH_AI !== "off" &&
    Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
  const server = await createApp({
    dataFile: process.env.DATA_FILE || path.join(here, "data", "db.json"),
    aiClient: aiOn ? new Anthropic() : null,
    secureCookies: process.env.COOKIE_SECURE === "1",
  });
  server.listen(port, () => {
    console.log(`Ishango Maths is running at http://localhost:${port}`);
    console.log(aiOn ? `AI tutor: on (${MODEL})` : "AI tutor: off (set ANTHROPIC_API_KEY to switch it on)");
  });
}
