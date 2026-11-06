// WHAT YEAR? — online party game server. No npm install needed (Node 18 or newer).
// On your computer: double-click "START WHAT YEAR" (or in the VS Code Terminal: node server.js)
// On the internet (Render): start command  node server.js
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec } = require("child_process");
const { growBank, status: searchStatus, shuffle } = require("./photos");

const ROOT = __dirname;
const PUB = path.join(ROOT, "public");
const BANK_FILE = path.join(ROOT, "bank.json");
const PORT = Number(process.env.PORT) || 3200;
const ONLINE = !!(process.env.RENDER || process.env.ONLINE);   // true when it runs on the internet
const ROUND_MS = 25000, REVEAL_MS = 10000;
const MIN_BANK = 250;          // after a restart, quietly look for more photos until there are at least this many
const MAX_BANK = 6000;
const MAX_TABLES = 300, MAX_PLAYERS = 10, MAX_SEEN = 3000;

function log(...a) { console.log(new Date().toISOString().slice(11, 19) + "  " + a.join(" ")); }

/* =========================================================
   PHOTO BANK — only links to photos on Wikimedia Commons, nothing downloaded
   ========================================================= */
let bank = [];
try { bank = JSON.parse(fs.readFileSync(BANK_FILE, "utf8")).filter(p => p && p.id && p.url && p.year); } catch {}
const byId = new Map(bank.map(p => [p.id, p]));
// the three photos on the home screen are only for decoration, never played
const previewIds = new Set(bank.slice(0, 3).map(p => p.id));
const playable = () => bank.filter(p => !previewIds.has(p.id) && !p.broken);

let growing = false, growTarget = 0;
function grow(extra, why) {
  if (growing || bank.length >= MAX_BANK) return;
  growing = true; growTarget = bank.length + extra;
  log(`Looking for ${extra} more photos (${why})…`);
  growBank(bank, extra, {
    onFound: p => { byId.set(p.id, p); if (!ONLINE) saveBank(); },
    log
  }).then(n => log(`Found ${n}. Photo bank: ${bank.length}`))
    .catch(e => log("Photo search stopped:", e.message))
    .finally(() => { growing = false; });
}
let saveTimer = 0;
function saveBank() { // only on your own computer; on Render the disk is wiped on every restart anyway
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { fs.writeFileSync(BANK_FILE, JSON.stringify(bank).replace(/\},\{/g, "},\n{")); } catch {} }, 3000);
}

/* =========================================================
   TABLES — one game per table code
   ========================================================= */
const tables = new Map();
const COLORS = ["#7c4dff", "#ff4f9a", "#1fa7f0", "#ff9f1c", "#14b886", "#ef476f", "#9b5de5", "#00a6a6"];
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const newId = () => require("crypto").randomBytes(9).toString("base64url");
function newCode() { let c; do { c = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join(""); } while (tables.has(c)); return c; }
// Guess the decade: the right decade = 1000, one decade off = 400, two off = 100
const decadeOf = y => Math.floor(y / 10) * 10;
function points(guess, year) { if (guess == null) return 0; const d = Math.abs(decadeOf(guess) - decadeOf(year)) / 10; return d === 0 ? 1000 : d === 1 ? 400 : d === 2 ? 100 : 0; }
const cleanSeen = list => new Set((Array.isArray(list) ? list : []).slice(-MAX_SEEN).map(String).filter(s => /^\d{1,12}$/.test(s)));

function makeTable() {
  const t = { code: newCode(), hostId: null, players: new Map(), clients: new Set(), phase: "lobby", order: [], round: 0, endsAt: 0, timer: null, rounds: 8, results: null, played: new Set(), swapped: -1, touched: Date.now() };
  tables.set(t.code, t); return t;
}
function addPlayer(t, name, color, seen) {
  const id = newId();
  const used = new Set([...t.players.values()].map(p => p.color));
  const c = COLORS.includes(color) && !used.has(color) ? color : (COLORS.find(x => !used.has(x)) || COLORS[t.players.size % COLORS.length]);
  t.players.set(id, { id, name: String(name || "Player").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 16) || "Player", color: c, score: 0, guess: null, seen: cleanSeen(seen) });
  if (!t.hostId) t.hostId = id;
  return id;
}
const online = (t, pid) => [...t.clients].some(c => c.pid === pid);
const photoOf = (t, i) => byId.get(t.order[i]);
function view(t, pid) {
  const p = photoOf(t, t.round);
  const showPhoto = (t.phase === "round" || t.phase === "reveal") && p;
  const nx = showPhoto && photoOf(t, t.round + 1);
  return {
    code: t.code, you: pid, isHost: pid === t.hostId, phase: t.phase, rounds: t.rounds,
    round: t.round + 1, total: t.order.length, remaining: Math.max(0, t.endsAt - Date.now()), roundMs: ROUND_MS, revealMs: REVEAL_MS,
    photo: showPhoto ? { id: p.id, url: p.url, city: p.city } : null,
    next: nx ? nx.url : null,   // so the browser can load the next photo early
    reveal: t.phase === "reveal" && p ? { year: p.year, caption: p.caption, credit: p.credit, page: p.page, results: t.results } : null,
    players: [...t.players.values()].map(x => ({ id: x.id, name: x.name, color: x.color, score: x.score, host: x.id === t.hostId, online: online(t, x.id), locked: t.phase === "round" && x.guess != null })),
    maxPlayers: MAX_PLAYERS
  };
}
function broadcast(t) {
  t.touched = Date.now();
  for (const c of t.clients) { try { c.res.write(`data: ${JSON.stringify(view(t, c.pid))}\n\n`); } catch {} }
}
function beginRound(t) {
  clearTimeout(t.timer);
  t.phase = "round"; t.results = null;
  t.players.forEach(p => p.guess = null);
  t.endsAt = Date.now() + ROUND_MS;
  t.timer = setTimeout(() => endRound(t), ROUND_MS + 300);
  broadcast(t);
}
function endRound(t) {
  if (t.phase !== "round") return;
  clearTimeout(t.timer);
  const p = photoOf(t, t.round);
  const year = p ? p.year : 0;
  t.results = [...t.players.values()].map(x => { const pts = points(x.guess, year); x.score += pts; return { id: x.id, guess: x.guess, points: pts }; });
  t.phase = "reveal"; t.endsAt = Date.now() + REVEAL_MS;
  t.timer = setTimeout(() => nextRound(t), REVEAL_MS);
  broadcast(t);
}
function nextRound(t) {
  if (t.phase !== "reveal") return;
  clearTimeout(t.timer);
  if (t.round + 1 >= t.order.length) { t.phase = "final"; t.endsAt = 0; broadcast(t); return; }
  t.round++; beginRound(t);
}

// The heart of "never the same photo twice":
// every browser remembers the photos it has played and sends that list when it joins a table.
// We pick photos that NOBODY at the table has seen. If we ever run short, we look for more on Commons,
// and meanwhile use the ones the fewest players at this table have seen.
function pickPhotos(t, n) {
  const players = [...t.players.values()];
  const timesSeen = p => players.reduce((k, x) => k + (x.seen.has(p.id) ? 1 : 0), 0) + (t.played.has(p.id) ? 100 : 0);
  const all = playable();
  const fresh = all.filter(p => timesSeen(p) === 0);
  if (fresh.length < n * 4) grow(Math.max(60, n * 6), `table ${t.code} is running low on new photos`);
  const pool = fresh.length >= n ? fresh : all;
  const chosen = shuffle(pool).sort((a, b) => timesSeen(a) - timesSeen(b) || (a.plays || 0) - (b.plays || 0)).slice(0, n);
  for (const p of chosen) { p.plays = (p.plays || 0) + 1; t.played.add(p.id); players.forEach(x => x.seen.add(p.id)); }
  return chosen.map(p => p.id);
}
function startGame(t, rounds) {
  t.rounds = [5, 8, 10, 15].includes(Number(rounds)) ? Number(rounds) : 8;
  t.order = pickPhotos(t, Math.min(t.rounds, playable().length));
  t.players.forEach(p => { p.score = 0; p.guess = null; });
  t.round = 0; t.swapped = -1; beginRound(t);
}
// A photo that won't load (deleted on Commons, say) is swapped for another one, once per round
function swapBroken(t, id) {
  if (t.phase !== "round" || t.order[t.round] !== id || t.swapped === t.round) return false;
  const bad = byId.get(id); if (bad) bad.broken = true;
  const players = [...t.players.values()];
  const inGame = new Set(t.order);
  const rep = shuffle(playable().filter(p => !inGame.has(p.id) && !t.played.has(p.id) && !players.some(x => x.seen.has(p.id))))[0]
    || shuffle(playable().filter(p => !inGame.has(p.id)))[0];
  if (!rep) return false;
  t.order[t.round] = rep.id; t.played.add(rep.id); players.forEach(x => x.seen.add(rep.id)); t.swapped = t.round;
  log(`Photo ${id} would not load at table ${t.code}; swapped for ${rep.id}`);
  beginRound(t);
  return true;
}
function maybeAllLocked(t) {
  if (t.phase !== "round") return;
  const active = [...t.players.values()].filter(p => online(t, p.id));
  if (active.length && active.every(p => p.guess != null)) endRound(t);
}
setInterval(() => { // tidy up tables nobody is using
  for (const [code, t] of tables) {
    const idle = Date.now() - t.touched;
    if ((!t.clients.size && idle > 20 * 60 * 1000) || idle > 6 * 3600 * 1000) { clearTimeout(t.timer); for (const c of t.clients) { try { c.res.end(); } catch {} } tables.delete(code); }
  }
}, 60 * 1000);

/* =========================================================
   Simple protection for a public website: limit how many tables one visitor can make or join
   ========================================================= */
const hits = new Map();
function tooMany(ip, max = 30, windowMs = 10 * 60 * 1000) {
  const now = Date.now(), h = (hits.get(ip) || []).filter(x => now - x < windowMs);
  h.push(now); hits.set(ip, h);
  return h.length > max;
}
setInterval(() => { const now = Date.now(); for (const [ip, h] of hits) if (!h.some(x => now - x < 600000)) hits.delete(ip); }, 5 * 60 * 1000);
const ipOf = req => (String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?");

/* =========================================================
   HTTP
   ========================================================= */
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };
function send(res, code, body, type = "application/json; charset=utf-8", cache = "no-store") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": cache, "X-Content-Type-Options": "nosniff" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function body(req) {
  return new Promise(resolve => {
    let s = ""; req.on("data", c => { s += c; if (s.length > 120000) { s = ""; req.destroy(); } });
    req.on("end", () => { try { resolve(JSON.parse(s || "{}")); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}
function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === "IPv4" && !a.internal) out.push(`http://${a.address}:${PORT}`);
  return out;
}
function serveFile(res, rel) {
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB)) return send(res, 403, "Forbidden", "text/plain");
  const ext = path.extname(file).toLowerCase();
  fs.readFile(file, (err, buf) => err ? send(res, 404, "Not found", "text/plain") : send(res, 200, buf, TYPES[ext] || "application/octet-stream", ext === ".woff2" ? "public, max-age=604800" : "no-cache"));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (req.method === "GET" && url.pathname === "/api/info") {
      return send(res, 200, {
        photos: playable().length, searching: growing ? { found: bank.length, target: growTarget, note: searchStatus.note } : null,
        online: ONLINE, lan: ONLINE ? [] : lanUrls(), tables: tables.size,
        preview: bank.filter(p => previewIds.has(p.id)).map(p => p.url)
      });
    }
    if (req.method === "POST" && url.pathname === "/api/credits") {   // the credits for the photos this browser has played
      const ids = [...cleanSeen((await body(req)).ids)];
      return send(res, 200, ids.map(id => byId.get(id)).filter(p => p && !p.broken).reverse().map(p => ({ caption: p.caption, credit: p.credit, page: p.page, year: p.year, city: p.city })));
    }
    if (req.method === "POST" && url.pathname === "/api/table") {
      const b = await body(req);
      if (tooMany(ipOf(req))) return send(res, 429, { error: "Too many tables from here. Wait a few minutes." });
      if (playable().length < 5) return send(res, 409, { error: "The photos are still loading. Give it a minute." });
      if (tables.size >= MAX_TABLES) return send(res, 503, { error: "The game is full right now. Try again in a few minutes." });
      const t = makeTable(); const pid = addPlayer(t, b.name, b.color, b.seen);
      log(`Table ${t.code} created (${tables.size} open)`);
      return send(res, 200, { code: t.code, pid });
    }
    if (parts[0] === "api" && parts[1] === "table" && parts[2]) {
      const t = tables.get(String(parts[2]).toUpperCase());
      if (!t) return send(res, 404, { error: "No table with that code. Check the letters and try again." });
      const action = parts[3];
      if (req.method === "GET" && action === "events") {
        const pid = url.searchParams.get("pid");
        if (!t.players.has(pid)) return send(res, 404, { error: "You're not at this table any more." });
        if (t.clients.size > MAX_PLAYERS * 3) return send(res, 503, { error: "Too many connections." });
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        res.write("retry: 2000\n\n");
        const client = { pid, res };
        t.clients.add(client); broadcast(t);
        const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 15000);
        req.on("close", () => {
          clearInterval(ping); t.clients.delete(client);
          if (t.hostId === pid && !online(t, pid)) {
            setTimeout(() => { // give the host a moment to reconnect before handing over
              if (online(t, pid) || t.hostId !== pid) return;
              const next = [...t.players.values()].find(p => online(t, p.id));
              if (next) { t.hostId = next.id; broadcast(t); }
            }, 8000);
          }
          broadcast(t); maybeAllLocked(t);
        });
        return;
      }
      if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
      const b = await body(req);
      if (action === "join") {
        if (tooMany(ipOf(req))) return send(res, 429, { error: "Too many tries from here. Wait a few minutes." });
        if (t.players.size >= MAX_PLAYERS) return send(res, 409, { error: `This table is full (${MAX_PLAYERS} players).` });
        const pid = addPlayer(t, b.name, b.color, b.seen);
        log(`Someone joined table ${t.code} (${t.players.size} players)`);
        broadcast(t); return send(res, 200, { code: t.code, pid });
      }
      const p = t.players.get(b.pid);
      if (!p) return send(res, 403, { error: "You're not at this table." });
      const host = b.pid === t.hostId;
      if (action === "start") {
        if (!host) return send(res, 403, { error: "Only the host can start." });
        if (t.phase !== "lobby") return send(res, 409, { error: "The game has already started." });
        if (playable().length < 5) return send(res, 409, { error: "Not enough photos yet." });
        startGame(t, b.rounds); return send(res, 200, { ok: true });
      }
      if (action === "guess") {
        if (t.phase !== "round") return send(res, 409, { error: "Too late for this round." });
        const y = decadeOf(Math.round(Number(b.year)));
        if (!(y >= 1880 && y <= 2020)) return send(res, 400, { error: "Pick a decade." });
        if (p.guess == null) { p.guess = y; broadcast(t); maybeAllLocked(t); }
        return send(res, 200, { ok: true });
      }
      if (action === "broken") { swapBroken(t, String(b.id || "")); return send(res, 200, { ok: true }); }
      if (action === "next") { if (!host) return send(res, 403, { error: "Only the host can do that." }); nextRound(t); return send(res, 200, { ok: true }); }
      if (action === "again") { if (!host) return send(res, 403, { error: "Only the host can do that." }); clearTimeout(t.timer); t.phase = "lobby"; t.order = []; t.round = 0; t.players.forEach(x => { x.score = 0; x.guess = null; }); broadcast(t); return send(res, 200, { ok: true }); }
      if (action === "leave") {
        t.players.delete(b.pid);
        for (const c of [...t.clients]) if (c.pid === b.pid) { try { c.res.end(); } catch {} t.clients.delete(c); }
        if (t.hostId === b.pid) t.hostId = ([...t.players.values()].find(x => online(t, x.id)) || [...t.players.values()][0] || {}).id || null;
        if (!t.players.size) { clearTimeout(t.timer); tables.delete(t.code); } else { broadcast(t); maybeAllLocked(t); }
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: "Unknown action" });
    }
    if (req.method === "GET" || req.method === "HEAD") return serveFile(res, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname));
    send(res, 405, "Method not allowed", "text/plain");
  } catch (e) {
    log("Error:", e.message); send(res, 500, { error: "Something went wrong. Try again." });
  }
});
server.keepAliveTimeout = 65000;

server.on("error", e => {
  if (e.code === "EADDRINUSE") console.log(`\n⚠️  Port ${PORT} is busy. Close the other WHAT YEAR window and try again.`);
  else console.log(e);
  process.exit(1);
});
server.listen(PORT, "0.0.0.0", () => {
  console.log("\n==================================================");
  console.log(`  WHAT YEAR? is running · ${bank.length} photos in the bank`);
  if (!ONLINE) {
    console.log("  On this computer:  http://localhost:" + PORT);
    for (const u of lanUrls()) console.log("  Friends on the same Wi-Fi:  " + u);
    console.log("  To stop: press control + C or close this window");
  } else console.log("  Online, port " + PORT);
  console.log("==================================================\n");
  if (bank.length < MIN_BANK) grow(MIN_BANK - bank.length + 20, "the bank is small");
  if (!ONLINE && process.platform === "darwin" && !process.env.NO_OPEN) exec(`open http://localhost:${PORT}`);
});
