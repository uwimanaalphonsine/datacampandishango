import {
  TOPICS, TOPIC_INFO, MAX_LEVEL, newProgress, normalizeProgress, isUnlocked,
  nextProblem, checkAnswer, recordResult, summarize,
} from "./engine.js";
import { objectSvg, childSvg } from "./objects.js";

const $ = (id) => document.getElementById(id);
const DEFAULT_SETTINGS = { thinkSeconds: 20, voice: true, ai: true };
const LOCAL_KEY = "ishango-math-v1"; // children's work when there is no server (offline demo)
const CURRENT_KEY = "ishango-math-current"; // which child last played on this device
const CHILD_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} '.-]{0,19}$/u; // same rule as the server

// "server": every child's work is saved to the grown-up's account.
// "local": no server to talk to (e.g. the web preview), so work stays in this browser.
let mode = "local";
let account = null; // { name, email } once a grown-up has logged in
const store = { profiles: {}, current: null };
let learner = null; // { name, progress, settings }
let aiAvailable = false;

function readLocal(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function writeLocal(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}
const currentKey = () => `${CURRENT_KEY}:${account?.email || ""}`;

// Small fetch wrapper: never throws, so callers can show a friendly message.
async function request(method, path, body) {
  try {
    const res = await fetch(path, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

function useLearner(name) {
  const isNew = !Object.hasOwn(store.profiles, name);
  const saved = store.profiles[name] || {};
  learner = {
    name,
    progress: normalizeProgress(saved.progress),
    settings: { ...DEFAULT_SETTINGS, ...(saved.settings || {}) },
  };
  store.current = name;
  if (mode === "server") writeLocal(currentKey(), name);
  if (isNew || mode === "local") persist();
}

// Saves the current child's work. On a server, saves are grouped for a
// moment and retried if the connection drops, with a small status in the
// top bar so grown-ups can see the work is safe.
const pending = new Set();
let saveTimer = null;
let saving = false;

function persist() {
  if (!learner) return;
  store.profiles[learner.name] = { progress: learner.progress, settings: learner.settings };
  if (mode === "local") {
    writeLocal(LOCAL_KEY, store);
    return;
  }
  pending.add(learner.name);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSaves, 400);
}

async function flushSaves() {
  if (saving) { saveTimer = setTimeout(flushSaves, 400); return; }
  if (!pending.size) return;
  saving = true;
  setSaveStatus("Saving…");
  try {
    for (const name of [...pending]) {
      pending.delete(name);
      const res = await request("PUT", `/api/children/${encodeURIComponent(name)}`, store.profiles[name]);
      if (res.status === 401) { pending.add(name); sessionExpired(); return; }
      if (!res.ok) {
        pending.add(name);
        setSaveStatus("⚠ Not saved yet", true);
        saveTimer = setTimeout(flushSaves, 10_000);
        return;
      }
    }
    setSaveStatus("✓ Saved");
    setTimeout(() => { if (!pending.size && !saving) setSaveStatus(""); }, 2000);
  } finally {
    saving = false;
  }
}

function setSaveStatus(text, bad = false) {
  const el = $("saveStatus");
  el.hidden = !text;
  el.textContent = text;
  el.classList.toggle("bad", bad);
}

// ---------------------------------------------------------------------------
// Voice

function speak(text) {
  if (!learner?.settings.voice || !("speechSynthesis" in window) || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/[−]/g, "minus").replace(/×/g, "times").replace(/÷/g, "shared by"));
  u.rate = 0.85;
  u.pitch = 1.1;
  speechSynthesis.speak(u);
}

// ---------------------------------------------------------------------------
// AI tutor (optional). Every call has a built-in fallback.

async function api(path, body, timeoutMs = 8000) {
  if (!aiAvailable || !learner?.settings.ai) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: ctrl.signal, credentials: "same-origin",
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Grown-ups' accounts

let authMode = "login";

function setAuthMode(m) {
  authMode = m;
  const reg = m === "register";
  $("tabLogin").classList.toggle("active", !reg);
  $("tabRegister").classList.toggle("active", reg);
  $("tabLogin").setAttribute("aria-selected", String(!reg));
  $("tabRegister").setAttribute("aria-selected", String(reg));
  $("authNameRow").hidden = !reg;
  $("authPassword").autocomplete = reg ? "new-password" : "current-password";
  $("authSubmit").textContent = reg ? "Create account" : "Log in";
  $("authHint").textContent = reg
    ? "Choose a password with at least 8 characters. Keep it away from the children."
    : "Use the email and password you signed up with.";
  $("authError").hidden = true;
}
$("tabLogin").onclick = () => setAuthMode("login");
for (const id of ["authName", "authEmail", "authPassword"]) $(id).addEventListener("input", () => { $("authError").hidden = true; });
$("tabRegister").onclick = () => setAuthMode("register");

function showAuth(message = "") {
  learner = null;
  $("authError").hidden = !message;
  $("authError").textContent = message;
  show("auth");
  $(authMode === "register" ? "authName" : "authEmail").focus();
}

$("authForm").onsubmit = async (e) => {
  e.preventDefault();
  const reg = authMode === "register";
  const name = $("authName").value.trim();
  const email = $("authEmail").value.trim();
  const password = $("authPassword").value;
  let problem = "";
  if (reg && !name) problem = "Please type your name.";
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) problem = "Please type a valid email address.";
  else if (password.length < 8) problem = "The password needs at least 8 characters.";
  if (problem) { showAuthError(problem); return; }

  $("authSubmit").disabled = true;
  const res = await request("POST", reg ? "/api/register" : "/api/login", reg ? { name, email, password } : { email, password });
  $("authSubmit").disabled = false;
  if (!res.ok) {
    showAuthError(res.data?.error || "Could not reach the server. Check the internet connection and try again.");
    return;
  }
  $("authPassword").value = "";
  $("authError").hidden = true;
  enterAccount(res.data);
};

function showAuthError(text) {
  $("authError").textContent = text;
  $("authError").hidden = false;
}

// Work that could not be saved before a login expired is kept here and
// saved again once the same grown-up logs back in.
let unsaved = null;

function enterAccount({ user, children }) {
  const sameAccount = unsaved && unsaved.email === user.email;
  account = user;
  store.profiles = children || {};
  if (sameAccount) {
    for (const [name, data] of Object.entries(unsaved.profiles)) {
      store.profiles[name] = data;
      pending.add(name);
    }
    flushSaves();
  }
  unsaved = null;
  store.current = readLocal(currentKey());
  startLearner();
}

function sessionExpired() {
  unsaved = { email: account?.email, profiles: Object.fromEntries([...pending].map((n) => [n, store.profiles[n]])) };
  pending.clear();
  setSaveStatus("");
  showAuth("Please log in again to keep saving.");
}

$("logoutBtn").onclick = async () => {
  clearTimeout(saveTimer);
  await flushSaves();
  if (pending.size) {
    $("accountText").textContent = "Some work is not saved yet. Check the internet connection, then try again.";
    return;
  }
  await request("POST", "/api/logout", {});
  $("settingsDialog").close();
  account = null;
  learner = null;
  store.profiles = {};
  store.current = null;
  setSaveStatus("");
  setAuthMode("login");
  showAuth();
};

function startLearner() {
  if (store.current && Object.hasOwn(store.profiles, store.current)) {
    useLearner(store.current);
    renderHome();
  } else {
    renderProfiles();
  }
  updateWriteNote();
}

// With a server, grown-ups log in; without one (the web preview), the app
// runs on its own and keeps work in this browser.
async function boot() {
  const status = await request("GET", "/api/status");
  if (status.ok && status.data?.accounts) {
    mode = "server";
    aiAvailable = status.data.ai === true;
    const me = await request("GET", "/api/me");
    if (me.ok) enterAccount(me.data);
    else showAuth();
    return;
  }
  mode = "local";
  aiAvailable = false;
  const saved = readLocal(LOCAL_KEY);
  if (saved?.profiles) Object.assign(store, saved);
  startLearner();
}

// ---------------------------------------------------------------------------
// Screens

const SCREENS = ["auth", "profiles", "home", "play", "progress"];
function show(name) {
  for (const s of SCREENS) $(`screen-${s}`).hidden = s !== name;
  $("homeBtn").hidden = name === "home" || name === "profiles" || name === "auth";
  $("settingsBtn").hidden = name === "auth";
  $("starCount").hidden = !learner;
  if (learner) $("starCount").textContent = `⭐ ${Math.floor(learner.progress.stars)}`;
  if (name !== "play") stopThinkTimer();
  window.scrollTo(0, 0);
}

function renderProfiles() {
  const list = $("profileList");
  list.innerHTML = "";
  for (const name of Object.keys(store.profiles).sort()) {
    const b = document.createElement("button");
    b.className = "btn";
    b.textContent = `🙂 ${name}`;
    b.onclick = () => { useLearner(name); renderHome(); };
    list.appendChild(b);
  }
  show("profiles");
}

$("newProfileForm").onsubmit = (e) => {
  e.preventDefault();
  const input = $("newName");
  const name = input.value.trim().replace(/\s+/g, " ");
  input.setCustomValidity(CHILD_NAME_RE.test(name) ? "" : "Use letters and numbers only, up to 20 characters.");
  if (!input.reportValidity()) return;
  input.value = "";
  useLearner(name);
  renderHome();
};

function renderHome() {
  $("helloTitle").textContent = `Hello, ${learner.name}!`;
  const grid = $("topicGrid");
  grid.innerHTML = "";
  for (const t of TOPICS) {
    const info = TOPIC_INFO[t];
    const open = isUnlocked(learner.progress, t);
    const level = learner.progress.topics[t].level;
    const b = document.createElement("button");
    b.className = `btn topic${open ? "" : " locked"}`;
    b.innerHTML = `<span class="sym">${open ? info.symbol : "🔒"}</span>
      <span>${info.title}</span>
      <span class="lvl">${open ? "★".repeat(level) + "☆".repeat(MAX_LEVEL - level) : unlockText(info.unlock)}</span>`;
    b.onclick = () => {
      if (open) startTopic(t);
      else speak(`Keep practising ${TOPIC_INFO[info.unlock.topic].title} to open ${info.title}.`);
    };
    grid.appendChild(b);
  }
  show("home");
}

function unlockText(rule) {
  return `Opens at ${TOPIC_INFO[rule.topic].title} ${"★".repeat(rule.level)}`;
}

$("homeBtn").onclick = () => renderHome();
$("progressBtn").onclick = () => renderProgress();

// ---------------------------------------------------------------------------
// Playing a problem

const round = {
  topic: null, problem: null, answer: "", attempts: 0, helped: false,
  startedAt: 0, done: false, lastKey: null, timer: null,
};

function startTopic(topic) {
  round.topic = topic;
  round.lastKey = null;
  newRound();
  show("play");
}

function newRound() {
  const p = nextProblem(learner.progress, round.topic, Math.random, round.lastKey);
  Object.assign(round, { problem: p, answer: "", attempts: 0, helped: false, done: false, checking: false, startedAt: Date.now() });
  round.lastKey = p.key;

  $("levelChip").textContent = `${TOPIC_INFO[p.topic].title} · Level ${p.level}`;
  $("reviewChip").hidden = !p.review;
  $("story").textContent = p.story;
  $("equation").textContent = p.topic === "count" ? "" : p.equation;
  $("feedback").hidden = true;
  $("nextBtn").hidden = true;
  setAnswer("");
  clearCanvas();
  setInputsEnabled(true);
  renderScene(p);
  startThinkTimer();
  speak(p.story);
}

$("speakBtn").onclick = () => speak(round.problem?.story);

// --- Pictures --------------------------------------------------------------

function itemButton(objId, onTap) {
  const b = document.createElement("button");
  b.className = "item";
  b.type = "button";
  b.innerHTML = objectSvg(objId);
  b.onclick = () => onTap(b);
  return b;
}

function toggleCounted(b) {
  if (!round.done) b.classList.toggle("counted");
}

function makeGroup(count, objId, { label, cls = "", onTap = toggleCounted } = {}) {
  const g = document.createElement("div");
  g.className = `group ${cls}`;
  if (label) g.innerHTML = `<div class="group-label">${label}</div>`;
  for (let i = 0; i < count; i++) g.appendChild(itemButton(objId, onTap));
  return g;
}

function op(symbol) {
  const s = document.createElement("span");
  s.className = "op";
  s.textContent = symbol;
  return s;
}

function renderScene(p) {
  const scene = $("scene");
  scene.innerHTML = "";
  const total = p.visual.groups.reduce((n, g) => n + g, 0);
  scene.classList.toggle("dense", total > 20);
  const obj = p.object;
  const tip = $("sceneTip");

  switch (p.visual.kind) {
    case "count":
      scene.appendChild(makeGroup(p.a, obj));
      tip.textContent = `Tap each ${p.objectName.one} as you count it.`;
      break;
    case "add":
      scene.appendChild(makeGroup(p.a, obj, { label: `${p.a} ${p.a === 1 ? p.objectName.one : p.objectName.many}` }));
      scene.appendChild(op("+"));
      scene.appendChild(makeGroup(p.b, obj, { label: `${p.b} more` }));
      tip.textContent = "Tap each one as you count them all.";
      break;
    case "sub": {
      const g = makeGroup(p.a, obj, { label: `${p.a} ${p.objectName.many}` });
      const items = [...g.querySelectorAll(".item")];
      items.slice(p.a - p.visual.remove).forEach((it) => it.classList.add("away"));
      scene.appendChild(g);
      tip.textContent = `The crossed-out ${p.objectName.many} are given away. Count the ones that stay.`;
      break;
    }
    case "mul":
      p.visual.groups.forEach((n, i) => scene.appendChild(makeGroup(n, obj, { cls: "basket", label: `Group ${i + 1}` })));
      tip.textContent = "Count the objects in every group.";
      break;
    case "div":
      renderSharing(scene, p);
      tip.textContent = `Tap a ${p.objectName.one} to give it to the next child.`;
      break;
  }
}

// Division: children share the pile by tapping, one object at a time.
function renderSharing(scene, p) {
  const kids = document.createElement("div");
  kids.className = "kids";
  const plates = [];
  for (let i = 0; i < p.b; i++) {
    const k = document.createElement("div");
    k.className = "kid";
    k.innerHTML = `${childSvg(i)}<div class="plate"></div>`;
    plates.push(k.querySelector(".plate"));
    kids.appendChild(k);
  }
  let next = 0;
  const deal = (b) => {
    if (round.done && !b.dataset.auto) return;
    b.remove();
    b.onclick = null;
    b.classList.remove("counted");
    plates[next % plates.length].appendChild(b);
    next += 1;
  };
  const pile = makeGroup(p.a, p.object, { label: "To share", onTap: deal });
  scene.appendChild(pile);
  scene.appendChild(kids);
  round.shareAll = () => {
    for (const b of [...pile.querySelectorAll(".item")]) { b.dataset.auto = "1"; deal(b); }
    return plates;
  };
}

// "Show me how": number the objects one by one, like counting with a finger.
async function demonstrate(p) {
  const scene = $("scene");
  let items;
  if (p.visual.kind === "div") {
    const plates = round.shareAll();
    items = [...plates[0].querySelectorAll(".item")];
    $("sceneTip").textContent = `Each child gets the same. Let's count one child's ${p.objectName.many}.`;
  } else {
    items = [...scene.querySelectorAll(".item")].filter((it) => !it.classList.contains("away"));
  }
  const step = Math.max(180, Math.min(600, 6000 / items.length));
  for (let i = 0; i < items.length; i++) {
    const n = document.createElement("span");
    n.className = "num";
    n.textContent = i + 1;
    items[i].classList.remove("counted");
    items[i].appendChild(n);
    await new Promise((r) => setTimeout(r, step));
  }
}

// --- Answer input ------------------------------------------------------------

function buildKeypad() {
  const pad = $("keypad");
  for (const k of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]) {
    const b = document.createElement("button");
    b.className = "btn";
    b.textContent = k;
    b.onclick = () => { if (round.answer.length < 3) setAnswer(round.answer + k); };
    pad.appendChild(b);
  }
  const del = document.createElement("button");
  del.className = "btn";
  del.textContent = "⌫";
  del.setAttribute("aria-label", "Rub out");
  del.style.gridColumn = "span 5";
  del.onclick = () => setAnswer(round.answer.slice(0, -1));
  pad.appendChild(del);
}

function setAnswer(text) {
  round.answer = text;
  $("answerBox").textContent = text;
  $("checkBtn").disabled = round.done || text === "";
}

function setInputsEnabled(on) {
  for (const b of document.querySelectorAll("#keypad .btn, #readWriteBtn, #clearWriteBtn, #hintBtn")) b.disabled = !on;
  $("checkBtn").disabled = !on || round.answer === "";
}

document.addEventListener("keydown", (e) => {
  if ($("screen-play").hidden || round.done || document.querySelector("dialog[open]")) return;
  if (/^\d$/.test(e.key) && round.answer.length < 3) setAnswer(round.answer + e.key);
  else if (e.key === "Backspace") setAnswer(round.answer.slice(0, -1));
  else if (e.key === "Enter" && round.answer) onCheck();
});

function selectTab(write) {
  $("tabTap").classList.toggle("active", !write);
  $("tabWrite").classList.toggle("active", write);
  $("tabTap").setAttribute("aria-selected", String(!write));
  $("tabWrite").setAttribute("aria-selected", String(write));
  $("keypad").hidden = write;
  $("writepad").hidden = !write;
  updateWriteNote();
}
$("tabTap").onclick = () => selectTab(false);
$("tabWrite").onclick = () => selectTab(true);

// --- Handwriting pad ---------------------------------------------------------

const canvas = $("writeCanvas");
const ctx = canvas.getContext("2d");
let drawing = false;
let inked = false;

function clearCanvas() {
  ctx.fillStyle = "#fffef8";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  inked = false;
}
function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return [(e.clientX - r.left) * (canvas.width / r.width), (e.clientY - r.top) * (canvas.height / r.height)];
}
canvas.addEventListener("pointerdown", (e) => {
  drawing = true;
  canvas.setPointerCapture(e.pointerId);
  const [x, y] = canvasPoint(e);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + 0.1, y + 0.1);
  ctx.stroke();
});
canvas.addEventListener("pointermove", (e) => {
  if (!drawing) return;
  const [x, y] = canvasPoint(e);
  ctx.lineTo(x, y);
  ctx.stroke();
  inked = true;
});
for (const ev of ["pointerup", "pointercancel", "pointerleave"]) canvas.addEventListener(ev, () => { drawing = false; });
ctx.lineWidth = 14;
ctx.lineCap = "round";
ctx.lineJoin = "round";
ctx.strokeStyle = "#2b2a33";
clearCanvas();

$("clearWriteBtn").onclick = clearCanvas;

function updateWriteNote() {
  const ai = aiAvailable && learner?.settings.ai;
  $("readWriteBtn").hidden = !ai;
  $("writeNote").textContent = ai
    ? "Write your number with your finger, then tap “Read my number”."
    : "Practise writing your number here, then tap the same number on the 🔢 Tap page.";
}

$("readWriteBtn").onclick = async () => {
  if (!inked) { say("Write your number in the box first.", "try"); return; }
  const btn = $("readWriteBtn");
  btn.disabled = true;
  btn.textContent = "👀 Reading…";
  const out = await api("/api/read-digits", { image: canvas.toDataURL("image/png") }, 15000);
  btn.disabled = round.done;
  btn.textContent = "👀 Read my number";
  if (out?.digits) {
    setAnswer(out.digits);
    say(`I think you wrote ${out.digits}. If that is right, tap Check!`, "try", false);
  } else {
    say("I could not read that. Try writing it bigger, or use the 🔢 Tap page.", "try", false);
  }
};

// --- Thinking time -----------------------------------------------------------
// "Show me how" stays locked while the child is given time to think. The bar
// fills gently; there is no countdown and no pressure.

function startThinkTimer() {
  stopThinkTimer();
  const total = learner.settings.thinkSeconds;
  const fill = $("thinkFill");
  $("showBtn").disabled = true;
  fill.style.width = "0";
  round.timer = setInterval(() => {
    const elapsed = (Date.now() - round.startedAt) / 1000;
    fill.style.width = `${Math.min(100, (100 * elapsed) / total)}%`;
    if (elapsed >= total) {
      $("showBtn").disabled = round.done;
      stopThinkTimer();
    }
  }, 500);
}
function stopThinkTimer() {
  clearInterval(round.timer);
  round.timer = null;
}

// --- Checking and feedback ---------------------------------------------------

function say(text, mood = "", voice = true) {
  const fb = $("feedback");
  fb.hidden = false;
  fb.className = `card feedback ${mood}`;
  $("mascot").textContent = mood === "good" ? "🎉" : "🦉";
  $("feedbackText").textContent = text;
  fb.scrollIntoView({ block: "nearest", behavior: "smooth" });
  if (voice) speak(text);
}

const PRAISE = [
  "Well done! You worked carefully.",
  "Yes! That is right. Great thinking!",
  "Brilliant! You worked it out yourself.",
  "Super! Your answer is correct.",
];
const NOT_YET = "Not yet. Let's look again.";

function recentNote() {
  const h = learner.progress.topics[round.topic].history.slice(-5);
  if (!h.length) return "";
  return `${h.filter((x) => x.firstTry).length} of the last ${h.length} problems in this topic were right first time.`;
}

// Asks the AI tutor for words to say, but never waits long: if it is slow or
// off, the built-in message is used.
async function tutorMessage(status, fallback) {
  const p = round.problem;
  const out = await api("/api/feedback", {
    problem: { topic: p.topic, level: p.level, story: p.story, equation: p.equation, answer: p.answer, a: p.a, b: p.b },
    childAnswer: round.answer, status, attempt: round.attempts, childName: learner.name, recentNote: recentNote(),
  }, 6000);
  return out?.message || fallback;
}

$("checkBtn").onclick = () => onCheck();

async function onCheck() {
  if (round.done || round.checking || !round.answer) return;
  const result = checkAnswer(round.problem, round.answer);
  if (result.status === "invalid") { say("Type or write a number first.", "try"); return; }
  round.attempts += 1;
  round.checking = true;
  setInputsEnabled(false);
  say("Let me see… 🤔", "", false);
  // A short pause so the answer feels considered, not instant.
  const [message] = await Promise.all([
    tutorMessage(result.status, result.status === "correct" ? PRAISE[Math.floor(Math.random() * PRAISE.length)] : `${NOT_YET} ${round.problem.hint}`),
    new Promise((r) => setTimeout(r, 900)),
  ]);
  round.checking = false;

  if (result.status === "correct") {
    finishRound(true, message);
    return;
  }
  if (round.attempts >= 3) {
    round.helped = true;
    await revealSolution("Good try! Let's count it together.");
    return;
  }
  say(message, "try");
  setAnswer("");
  clearCanvas();
  setInputsEnabled(true);
}

$("hintBtn").onclick = async () => {
  round.helped = true;
  $("hintBtn").disabled = true;
  say("💡 " + await tutorMessage("hint", round.problem.hint), "try");
  $("hintBtn").disabled = round.done;
};

$("showBtn").onclick = async () => {
  round.helped = true;
  await revealSolution("Let's work it out together.");
};

async function revealSolution(intro) {
  const p = round.problem;
  round.done = true;
  setInputsEnabled(false);
  $("showBtn").disabled = true;
  say(intro, "try");
  await demonstrate(p);
  setAnswer(String(p.answer));
  const worked = p.topic === "count"
    ? `There are ${p.answer} ${p.answer === 1 ? p.objectName.one : p.objectName.many}.`
    : `The answer is ${p.answer}. ${p.equation.replace("?", p.answer)}`;
  finishRound(false, `${worked} Now you know how!`);
}

function finishRound(solved, message) {
  const p = round.problem;
  round.done = true;
  stopThinkTimer();
  setInputsEnabled(false);
  $("showBtn").disabled = true;
  for (const it of document.querySelectorAll("#scene .item")) it.disabled = true;
  const { levelChange } = recordResult(learner.progress, p, {
    solved, attempts: round.attempts, helped: round.helped, seconds: (Date.now() - round.startedAt) / 1000,
  });
  persist();
  $("starCount").textContent = `⭐ ${Math.floor(learner.progress.stars)}`;
  let extra = "";
  if (levelChange > 0) extra = ` 🌟 You are ready for level ${learner.progress.topics[p.topic].level}!`;
  if (levelChange < 0) extra = " Let's practise some easier ones together.";
  say(message + extra, solved ? "good" : "try");
  $("nextBtn").hidden = false;
  $("nextBtn").focus();
}

$("nextBtn").onclick = () => newRound();

// ---------------------------------------------------------------------------
// Progress

function renderProgress() {
  $("progressTitle").textContent = `${learner.name}'s progress`;
  const list = $("progressList");
  list.innerHTML = "";
  const sum = summarize(learner.progress);
  for (const t of TOPICS) {
    const s = sum[t];
    const row = document.createElement("div");
    row.className = "card prog";
    const detail = s.attempted
      ? `${s.attempted} tried · ${s.solvedPercent}% solved · recently ${s.recentFirstTryPercent}% right first time`
      : s.unlocked ? "Not started yet" : "Locked";
    row.innerHTML = `<strong>${TOPIC_INFO[t].symbol} ${s.title}</strong><span>Level ${s.level}</span>
      <div class="bar"><span style="width:${(100 * s.level) / MAX_LEVEL}%"></span></div><small>${detail}</small>`;
    list.appendChild(row);
  }
  const ai = aiAvailable && learner.settings.ai;
  $("reportBtn").hidden = !ai;
  $("reportText").textContent = ai
    ? "Ask the AI tutor for a short note about what is going well and what to practise next."
    : "The AI note is available when the AI tutor is switched on.";
  show("progress");
}

$("reportBtn").onclick = async () => {
  $("reportBtn").disabled = true;
  $("reportText").textContent = "Writing a note…";
  const out = await api("/api/report", { name: learner.name, stats: summarize(learner.progress) }, 20000);
  $("reportText").textContent = out?.summary || "Sorry, the note could not be written right now. Please try again later.";
  $("reportBtn").disabled = false;
};

// ---------------------------------------------------------------------------
// Settings

$("settingsBtn").onclick = () => {
  const s = learner?.settings || DEFAULT_SETTINGS;
  $("setThink").value = String(s.thinkSeconds);
  $("setVoice").checked = s.voice;
  $("setAi").checked = s.ai;
  $("setAi").disabled = !aiAvailable;
  $("aiStatus").textContent = aiAvailable
    ? "The AI tutor gives personal hints, reads handwriting and writes progress notes."
    : "The AI tutor is not set up on this server. The app works fully without it.";
  for (const id of ["setThink", "setVoice", "setAi", "resetBtn", "switchLearnerBtn"]) $(id).disabled = !learner || (id === "setAi" && !aiAvailable);
  $("accountRow").hidden = !account;
  if (account) $("accountText").textContent = `Logged in as ${account.name} (${account.email}). Every child's work is saved to this account.`;
  $("settingsDialog").showModal();
};

$("settingsDialog").addEventListener("close", () => {
  if (!learner) return;
  learner.settings.thinkSeconds = Number($("setThink").value) || DEFAULT_SETTINGS.thinkSeconds;
  learner.settings.voice = $("setVoice").checked;
  learner.settings.ai = $("setAi").checked;
  if (!learner.settings.voice && "speechSynthesis" in window) speechSynthesis.cancel();
  persist();
  updateWriteNote();
});

$("switchLearnerBtn").onclick = () => {
  $("settingsDialog").close();
  learner = null;
  store.current = null;
  if (mode === "local") writeLocal(LOCAL_KEY, store);
  else writeLocal(currentKey(), null);
  renderProfiles();
};

// Reset needs a second tap, so a child cannot wipe progress by accident.
let resetArmed = false;
$("resetBtn").onclick = () => {
  if (!learner) return;
  if (!resetArmed) {
    resetArmed = true;
    $("resetBtn").textContent = `Tap again to reset ${learner.name}`;
    setTimeout(() => { resetArmed = false; $("resetBtn").textContent = "Reset this learner"; }, 4000);
    return;
  }
  resetArmed = false;
  $("resetBtn").textContent = "Reset this learner";
  learner.progress = newProgress();
  persist();
  $("settingsDialog").close();
  renderHome();
};

// ---------------------------------------------------------------------------

buildKeypad();
await boot();
