// Passwords and login sessions.
//
// Passwords are stored only as salted scrypt hashes. Session tokens live in an
// HttpOnly cookie; the database keeps only a SHA-256 of each token, so a copy
// of the database cannot be used to log in.

import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
const KEY_LEN = 64;
export const SESSION_DAYS = 30;
export const COOKIE_NAME = "im_session";

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("base64");
  const hash = (await scrypt(password, salt, KEY_LEN)).toString("base64");
  return `scrypt$${salt}$${hash}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(password, salt, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("base64url");

export function createSession(store, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  store.data.sessions[sha256(token)] = { userId, expires: Date.now() + SESSION_DAYS * 86_400_000 };
  pruneSessions(store);
  return token;
}

export function sessionUser(store, token) {
  if (!token) return null;
  const s = store.data.sessions[sha256(token)];
  if (!s || s.expires < Date.now()) return null;
  return store.getUser(s.userId);
}

export function endSession(store, token) {
  if (token) delete store.data.sessions[sha256(token)];
}

function pruneSessions(store) {
  const now = Date.now();
  for (const [k, s] of Object.entries(store.data.sessions)) if (s.expires < now) delete store.data.sessions[k];
}

export function readCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function sessionCookie(token, { secure }) {
  const attrs = [`${COOKIE_NAME}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (secure) attrs.push("Secure");
  attrs.push(token ? `Max-Age=${SESSION_DAYS * 86_400}` : "Max-Age=0");
  return attrs.join("; ");
}

// Slows down password guessing: at most `limit` failed logins per key
// (address + email) in each window.
export class LoginLimiter {
  constructor({ limit = 8, windowMs = 15 * 60_000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.fails = new Map();
  }
  blocked(key) {
    const f = this.fails.get(key);
    if (!f || f.until < Date.now()) return false;
    return f.count >= this.limit;
  }
  fail(key) {
    const now = Date.now();
    const f = this.fails.get(key);
    if (!f || f.until < now) this.fails.set(key, { count: 1, until: now + this.windowMs });
    else f.count += 1;
  }
  clear(key) {
    this.fails.delete(key);
  }
}
