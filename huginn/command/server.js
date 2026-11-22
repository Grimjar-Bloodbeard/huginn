// Huginn command center: a live, read-only view of the home network.
// Runs the eyes (packet capture, Windows speed counters, pings, which program
// owns which port, Odin's Watch devices) and streams them to the screen.
// Listens on this PC only (127.0.0.1). Changes nothing on the network, with one exception:
// zones, which change Pi-hole groups only after you see a preview and tap Move (lib/pihole-admin.js).

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");
const readline = require("readline");
const dns = require("dns").promises;

const { Flows } = require("../lib/flows");
const { assessLine, median } = require("../lib/line");
const { PiholeClient, toLookup } = require("../lib/pihole");
const { Baseline } = require("../lib/baseline");
const { Push, checkSub } = require("../lib/push");
const { readReports, matchReport } = require("../lib/muninn");
const { findNmap, nmapArgs, parseNmapXml, checkDeepLook } = require("../lib/deeplook");
const { enumerate } = require("../lib/enumerate");
const { guessIcon, checkRename, guessLink, checkLink } = require("../lib/devices");
const { History } = require("../lib/history");
const { checkHouse, emptyHouse, sniffAsset, assetsInUse, ASSET, ASSET_TYPES } = require("../lib/house");
const crypto = require("crypto");
const { PiholeAdmin } = require("../lib/pihole-admin");
const Z = require("../lib/zones");

const PORT = Number(process.env.HUGINN_PORT || 33613); // random on purpose (Vault rule random-ports)
const ODIN = process.env.ODIN_URL || "http://127.0.0.1:7331";
// Odin's Watch only accepts changes that carry this header (another website can't send it).
const ODIN_POST = { "Content-Type": "application/json", "X-Odin": "1" };
// Where things live. At home these are the defaults; the Ravens kit (a USB stick for a lab) sets them
// with HUGINN_CONFIG, HUGINN_DATA, HUGINN_PYTHON and ODIN_URL so nothing depends on this PC.
const PUBLIC = path.join(__dirname, "public");
const PY = process.env.HUGINN_PYTHON || path.join(__dirname, ".venv", "Scripts", "python.exe");
const ROOT = path.join(__dirname, "..");

const CONFIG_FILE = path.resolve(ROOT, process.env.HUGINN_CONFIG || "config.local.json");
const CONFIG_DIR = path.dirname(CONFIG_FILE);   // secrets (pihole.local.json) sit next to the config
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(path.resolve(CONFIG_DIR, file), "utf8").replace(/^﻿/, "")); } catch { return {}; }
}
const CONFIG = readJson(CONFIG_FILE);
const DATA = path.resolve(ROOT, process.env.HUGINN_DATA || "data");
const ODIN_FILE = CONFIG.odinDevicesFile || "../odin/network_topology.json";
const SITE = CONFIG.siteName ? String(CONFIG.siteName).slice(0, 60) : null;   // e.g. "Room 214 lab"; null at home

// Huginn's own per-device settings (icon choice), keyed by hardware address. data/ is gitignored.
const META_FILE = path.join(DATA, "devices.json");
const HOUSE_FILE = path.join(DATA, "house.json");
function readHouse() { try { const c = checkHouse(JSON.parse(fs.readFileSync(HOUSE_FILE, "utf8"))); return c.ok ? c.house : emptyHouse(); } catch { return emptyHouse(); } }
function writeHouse(h) {
  fs.mkdirSync(path.dirname(HOUSE_FILE), { recursive: true });
  fs.writeFileSync(HOUSE_FILE + ".tmp", JSON.stringify(h, null, 2));
  fs.renameSync(HOUSE_FILE + ".tmp", HOUSE_FILE);   // never a half-written plan
}
const ZONES_FILE = path.join(DATA, "zones.json");
function readZones() { try { return Z.checkZonesFile(JSON.parse(fs.readFileSync(ZONES_FILE, "utf8"))); } catch { return Z.checkZonesFile({}); } }
function writeZones(z) {
  fs.mkdirSync(path.dirname(ZONES_FILE), { recursive: true });
  fs.writeFileSync(ZONES_FILE + ".tmp", JSON.stringify(z, null, 2));
  fs.renameSync(ZONES_FILE + ".tmp", ZONES_FILE);
}
// Pictures and 3D models uploaded for the floor plan. Files nobody points at are tidied away.
const ASSET_DIR = path.join(DATA, "house-assets");
const UPLOAD_TYPES = ["image/png", "image/jpeg", "image/webp", "model/gltf-binary", "application/octet-stream"];
function tidyAssets(house) {
  const keep = assetsInUse(house);
  let names = []; try { names = fs.readdirSync(ASSET_DIR); } catch { return; }
  for (const n of names) {
    if (keep.has(n)) continue;
    try { const st = fs.statSync(path.join(ASSET_DIR, n)); if (Date.now() - st.mtimeMs > 15 * 60 * 1000) fs.unlinkSync(path.join(ASSET_DIR, n)); } catch { /* gone */ }
  }
}
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("too big")); req.destroy(); } else parts.push(c); });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

function readMeta() { try { return JSON.parse(fs.readFileSync(META_FILE, "utf8")); } catch { return {}; } }
function writeMeta(meta) {
  fs.mkdirSync(path.dirname(META_FILE), { recursive: true });
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
}

const state = {
  iface: null,
  capture: { on: false, note: "Starting" },
  gateway: null,
  devices: [], subnets: [], devicesAt: null,
  down: 0, up: 0, peakDown: 0, peakUp: 0,
  routerMs: [], netMs: [],
  pihole: { on: false, note: "Not set up" }, piholeIp: null,
};

function localIps() {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) ips.push(a.address);
  return ips;
}

const flows = new Flows({ localIps: localIps() });

// ---------- Odin's Watch: the device list ----------
async function loadDevices() {
  let topo = null;
  try {
    const r = await fetch(`${ODIN}/api/topology`, { signal: AbortSignal.timeout(4000) });
    if (r.ok) topo = await r.json();
  } catch { /* fall back to the file */ }
  if (!topo) {
    try { topo = JSON.parse(fs.readFileSync(ODIN_FILE, "utf8")); } catch { return; }
  }
  state.subnets = topo.subnets || [];
  const meta = readMeta();
  state.devices = (topo.devices || []).map((d) => {
    const mac = (d.mac || "").toUpperCase();
    const base = {
      ip: d.ip, mac, name: d.label || d.router_name || d.hostname || null, label: d.label || null,
      hostname: d.hostname || d.router_name || null,
      vendor: d.vendor || null, type: d.device_type || "unknown", subnet: d.subnet || null,
      role: d.role || null, status: d.status || null, lastSeen: d.last_seen || null,
      firstSeen: d.first_seen || null, ports: d.open_ports || [], privateMac: !!d.private_mac,
    };
    const chosen = meta[mac] && meta[mac].icon;
    const icon = chosen || guessIcon(base), link = meta[mac] && meta[mac].link;
    return { ...base, icon, iconChosen: !!chosen, link: link || guessLink({ icon }), linkChosen: !!link };
  });
  state.devicesAt = Date.now();
  const trusted = state.subnets.find((s) => s.role === "trusted") || state.subnets[0];
  if (trusted && trusted.gateway && !state.gateway) setGateway(trusted.gateway);
}

function setGateway(gw) {
  state.gateway = gw;
  flows.gateway = gw;
  flows.dnsServers.add(gw);
}

// ---------- Packet capture ----------
let sniffer = null, sniffBackoff = 1000;
function startSniffer() {
  if (!fs.existsSync(PY)) {
    state.capture = { on: false, note: "Capture isn't set up: run npm run setup-command" };
    return;
  }
  sniffer = spawn(PY, ["-u", path.join(__dirname, "sniffer.py")], { windowsHide: true });
  const rl = readline.createInterface({ input: sniffer.stdout });
  rl.on("line", (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.p) { flows.ingest(m.p); return; }
    if (m.dns) { for (const ip of m.ips) flows.learnName(ip, m.dns, "dns"); return; }
    if (m.sni) { flows.learnName(m.ip, m.sni, "sni"); return; }
    if (m.iface) {
      state.iface = m.iface;
      flows.setLocalIps(m.ips);
      state.capture = { on: true, note: `Watching ${m.iface}` };
      sniffBackoff = 1000;
    }
  });
  let err = "";
  sniffer.stderr.on("data", (d) => { err = (err + d).slice(-400); });
  sniffer.on("exit", () => {
    const last = err.trim().split("\n").pop() || "stopped";
    state.capture = { on: false, note: `Capture stopped (${last}). Restarting.` };
    setTimeout(startSniffer, sniffBackoff);
    sniffBackoff = Math.min(sniffBackoff * 2, 30000);
  });
}

// ---------- True up/down speed from Windows' own counters ----------
const SKIP_ADAPTER = /isatap|teredo|loopback|vethernet|virtual|tailscale|wintun|miniport|bluetooth|hyper-v|wsl/i;
function startSpeed() {
  const p = spawn("typeperf", ["-si", "1",
    "\\Network Interface(*)\\Bytes Received/sec", "\\Network Interface(*)\\Bytes Sent/sec"], { windowsHide: true });
  let header = null;
  const rl = readline.createInterface({ input: p.stdout });
  rl.on("line", (line) => {
    const cells = line.match(/"([^"]*)"/g);
    if (!cells) return;
    const v = cells.map((c) => c.slice(1, -1));
    if (!header) { if (v[0].startsWith("(PDH")) header = v; return; }
    let down = 0, up = 0;
    for (let i = 1; i < v.length; i++) {
      const name = header[i] || "";
      if (SKIP_ADAPTER.test(name)) continue;
      const n = parseFloat(v[i]); if (!Number.isFinite(n)) continue;
      if (name.endsWith("Bytes Received/sec")) down = Math.max(down, n); else up = Math.max(up, n);
    }
    state.down = down; state.up = up;
    state.peakDown = Math.max(state.peakDown, down); state.peakUp = Math.max(state.peakUp, up);
  });
  p.on("exit", () => setTimeout(startSpeed, 5000));
}

// ---------- Latency: router and internet ----------
function ping(host) {
  return new Promise((res) => {
    execFile("ping", ["-n", "1", "-w", "1000", host], { windowsHide: true }, (e, out) => {
      const m = /time([=<])(\d+)ms/i.exec(out || "");
      res(m ? (m[1] === "<" ? 0.5 : Number(m[2])) : null);
    });
  });
}
function keep(arr, v, n = 150) { arr.push(v); if (arr.length > n) arr.shift(); }
// The router is always pinged (it's on the local network). The internet-latency ping is opt-in:
// at home it defaults to 1.1.1.1, but in a lab (SITE set) it is off unless config sets pingTarget,
// so the kit makes no repeated connection to the internet by default.
const NET_PING = CONFIG.pingTarget === undefined ? (SITE ? null : "1.1.1.1") : (CONFIG.pingTarget || null);
async function pingLoop() {
  const [r, n] = await Promise.all([state.gateway ? ping(state.gateway) : null, NET_PING ? ping(NET_PING) : Promise.resolve(null)]);
  if (state.gateway) keep(state.routerMs, r);
  if (NET_PING) keep(state.netMs, n);
  setTimeout(pingLoop, 2000);
}

// ---------- Which program owns which port ----------
function run(cmd, args) {
  return new Promise((res) => execFile(cmd, args, { windowsHide: true, maxBuffer: 8 << 20 },
    (e, out) => res(out || "")));
}
async function portsLoop() {
  const [ns, tl] = await Promise.all([run("netstat", ["-ano"]), run("tasklist", ["/fo", "csv", "/nh"])]);
  const names = new Map();
  for (const line of tl.split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line);
    if (m) names.set(m[2], m[1].replace(/\.exe$/i, ""));
  }
  const map = new Map();
  for (const line of ns.split(/\r?\n/)) {
    const m = /^\s*(TCP|UDP)\s+(\S+)\s+\S+\s+(?:\S+\s+)?(\d+)\s*$/.exec(line);
    if (!m) continue;
    const port = m[2].slice(m[2].lastIndexOf(":") + 1);
    const prog = names.get(m[3]);
    if (prog && m[3] !== "0") map.set(`${m[1].toLowerCase()}:${port}`, prog);
  }
  flows.setPorts(map);
  setTimeout(portsLoop, 3000);
}

// ---------- Asking Odin's Watch to scan now ----------
state.scan = { running: false, note: null };
async function startScan() {
  try {
    const r = await fetch(`${ODIN}/api/rescan`, { method: "POST", headers: ODIN_POST, body: "{}", signal: AbortSignal.timeout(5000) });
    const j = await r.json().catch(() => ({}));
    state.scan = { running: true, note: j.status === "already_running" ? "Odin's Watch is already scanning" : "Scanning the network", at: Date.now() };
  } catch {
    state.scan = { running: false, note: "Odin's Watch didn't answer. Is it running?" };
    return state.scan;
  }
  // A scan takes a minute or two: re-read the device list every 10 s for 3 minutes.
  let n = 0;
  const t = setInterval(async () => {
    await loadDevices();
    send("devices", { devices: state.devices, subnets: state.subnets });
    if (++n >= 18) { clearInterval(t); state.scan = { running: false, note: "Scan finished" }; send("scan", state.scan); }
  }, 10000);
  send("scan", state.scan);
  return state.scan;
}

// ---------- Pi-hole on the Pi-hole host: who looked up what ----------
const lookupQueue = [];
let pihole = null;
async function piholeLoop() {
  if (!pihole) {
    const secret = readJson("pihole.local.json");
    if (!CONFIG.piholeUrl) { state.pihole = { on: false, note: SITE ? "" : "Pi-hole not set up: add piholeUrl to config.local.json" }; return; }
    if (!secret.appPassword) {
      state.pihole = { on: false, note: "Pi-hole needs its app password: run setup/set-pihole-password.ps1" };
      return setTimeout(piholeLoop, 15000);
    }
    pihole = new PiholeClient({ url: CONFIG.piholeUrl, password: secret.appPassword });
    state.piholeIp = new URL(CONFIG.piholeUrl).hostname;
    backfillBaseline(pihole, pihole.since - 3).catch((e) => console.error("Unusual backfill:", e.message));
  }
  try {
    const list = await pihole.newLookups();
    for (const l of list) lookupQueue.push(flows.ingestLookup(l, state.piholeIp));
    learnLive(list);
    if (lookupQueue.length > 4000) lookupQueue.splice(0, lookupQueue.length - 4000);
    state.pihole = { on: true, note: "Reading Pi-hole" };
  } catch (e) {
    state.pihole = { on: false, note: e.message };
    // A refused password may have been fixed with the setup script: read the file again.
    if (/refused/.test(e.message)) { pihole = null; return setTimeout(piholeLoop, 10000); }
  }
  setTimeout(piholeLoop, 2000);
}
// Lookups arrive in 2-second batches; replay them 3 s behind so they flow like real time.
function releaseLookups(now) {
  const out = [];
  while (lookupQueue.length && lookupQueue[0].t <= now - 3 && out.length < 40) out.push(lookupQueue.shift());
  return out;
}

// ---------- Names for addresses nobody looked up (reverse DNS) ----------
const ptrTried = new Set();
async function ptrLoop() {
  const todo = flows.unnamed(40).filter((ip) => !ptrTried.has(ip)).slice(0, 8);
  await Promise.all(todo.map(async (ip) => {
    ptrTried.add(ip);
    try {
      const names = await Promise.race([dns.reverse(ip), new Promise((_, rej) => setTimeout(() => rej(new Error("slow")), 2500))]);
      if (names && names[0]) flows.learnName(ip, names[0], "ptr");
    } catch { /* no reverse name; stays unnamed */ }
  }));
  if (ptrTried.size > 20000) ptrTried.clear();
  setTimeout(ptrLoop, 2000);
}

// ---------- Memory: a week of who talked to whom, for Replay ----------
const history = new History(path.join(DATA, "history"));
let historyOldest = history.oldest();
setInterval(() => {
  try { history.flush(8); if (historyOldest == null) historyOldest = history.oldest(); }   // lookups arrive a few seconds late
  catch (e) { console.error("history:", e.message); }
}, 5000);
setInterval(() => {
  try { history.tidy(); historyOldest = history.oldest(); } catch (e) { console.error("history tidy:", e.message); }
}, 10 * 60 * 1000);

// ---------- Unusual: what's normal for each device, and what isn't ----------
const BASE_FILE = path.join(DATA, "baseline.json");
function lookupId(ip) {   // a device's key: its hardware address when known
  if (!ip || ip === state.gateway || ip === state.piholeIp || ip === "127.0.0.1" || ip === "::1") return null;   // the router asks for others
  const d = state.devices.find((x) => x.ip === ip);
  return d && d.mac ? d.mac : `ip:${ip}`;
}
const baseline = new Baseline({
  data: (() => { try { return JSON.parse(fs.readFileSync(BASE_FILE, "utf8")); } catch { return null; } })(),
  kindOf: (id) => { const d = state.devices.find((x) => x.mac === id); return d ? d.icon : null; },
});
let unusualChanged = false, backfilling = false, heldLive = [];
function learnLive(list) { if (backfilling) heldLive.push(...list); else learnLookups(list); }
function learnLookups(list) {
  for (const l of list) { const f = baseline.observe({ ...l, id: lookupId(l.ip) }); if (f.length) { unusualChanged = true; queueAlerts(f); } }
}

// ---------- Muninn's host checks (read-only; Muninn runs on each computer, Huginn only reads its reports) ----------
const MUNINN_DIR = process.env.MUNINN_REPORTS || CONFIG.muninnReports || "D:/Muninn/reports";
let muninn = {}, muninnSig = "";
function loadMuninn() {
  const out = {};
  for (const r of readReports(MUNINN_DIR)) {
    const key = matchReport(r, state.devices, [...flows.local]) || `host:${r.computer}`;
    if (!out[key] || out[key].time < r.time) out[key] = r;
  }
  const sig = JSON.stringify(out);
  if (sig !== muninnSig) { muninnSig = sig; muninn = out; if (clients.size) send("muninn", muninn); }
}
setInterval(() => { try { loadMuninn(); } catch (e) { console.error("muninn:", e.message); } }, 30000);

// ---------- Deep look: an optional, on-demand nmap scan of one device (never the auto sweep) ----------
const NMAP = findNmap(CONFIG);
const deepLook = { running: null, results: {} };   // ip -> last parsed result
function runDeepLook(ip, os) {
  if (deepLook.running) return Promise.resolve({ error: "A deep look is already running. One at a time." });
  const exe = NMAP || "nmap";   // try PATH if no known file
  deepLook.running = ip;
  if (clients.size) send("deeplook", { running: ip });
  return new Promise((resolve) => {
    let out = "", err = "", done = false;
    let child;
    try { child = spawn(exe, nmapArgs(ip, { os }), { windowsHide: true }); }
    catch { deepLook.running = null; return resolve({ error: "nmap isn't installed on this computer." }); }
    const finish = (res) => { if (done) return; done = true; deepLook.running = null; resolve(res); };
    child.on("error", (e) => finish({ error: /ENOENT/.test(e.code || e.message) ? "nmap isn't installed on this computer." : e.message }));
    child.stdout.on("data", (d) => { out += d; if (out.length > 4e6) child.kill(); });
    child.stderr.on("data", (d) => { err = (err + d).slice(-500); });
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish({ error: "The deep look took too long and was stopped." }); }, 150000);
    child.on("exit", () => {
      clearTimeout(timer);
      const r = parseNmapXml(out);
      if (r.error && err) r.error = err.trim().split("\n").pop();
      r.ip = r.ip || ip; r.at = Math.floor(Date.now() / 1000);
      if (!r.error) deepLook.results[ip] = r;
      if (clients.size) send("deeplook", { running: null, ip, result: deepLook.results[ip] || null });
      finish(r);
    });
  });
}

// ---------- Enumerate: Huginn's own deep scan of one device (no external tools) ----------
const enumState = { running: null, results: {} };   // ip -> last report
async function runEnumerate(ip) {
  if (enumState.running) return { error: "A scan is already running. One at a time." };
  enumState.running = ip;
  if (clients.size) send("enum", { running: ip, phase: "start" });
  try {
    const dev = state.devices.find((d) => d.ip === ip);
    const r = await enumerate(ip, {
      knownOpen: (dev && dev.ports) || [],
      onProgress: (p) => { if (clients.size) send("enum", { running: ip, phase: p.phase, port: p.port, open: p.open }); },
    });
    enumState.results[ip] = r;
    if (clients.size) send("enum", { running: null, ip, result: r });
    return r;
  } catch (e) {
    return { error: e.message || "The scan failed." };
  } finally { enumState.running = null; if (clients.size) send("enum", { running: null }); }
}

// ---------- Phone alerts ----------
const push = new Push(DATA);
let alertQueue = [];
function deviceFor(id, ip) { return state.devices.find((d) => (id && d.mac === id) || (ip && d.ip === ip)) || null; }
function queueAlerts(findings) {
  const fresh = Date.now() / 1000 - 3600;
  for (const f of findings) if (!f.quiet && f.t > fresh) alertQueue.push(f);   // never alerts for old history or while learning
}
function notify(note) {
  if (!push.subs.length) return;
  push.send(note).then((r) => { for (const x of r.failed) console.error("push:", x.error); }).catch((e) => console.error("push:", e.message));
}
setInterval(() => {   // at most one alert every 30 seconds, several findings rolled into it
  if (!alertQueue.length) return;
  const list = alertQueue; alertQueue = [];
  const name = (f) => { const d = deviceFor(f.id, f.ip); return (d && d.name) || f.ip || "A device"; };
  notify(list.length === 1
    ? { title: `Unusual: ${name(list[0])}`, body: list[0].title, url: "./#unusual", tag: "unusual" }
    : { title: `Unusual: ${list.length} things`, body: list.slice(0, 4).map((f) => `${name(f)}: ${f.title}`).join("\n"), url: "./#unusual", tag: "unusual" });
}, 30000);
let knownMacs = null;
function alertNewDevices() {
  const macs = state.devices.map((d) => d.mac).filter(Boolean);
  if (knownMacs) for (const d of state.devices) if (d.mac && !knownMacs.has(d.mac)) {
    notify({ title: "New device on the network", body: `${d.name || d.vendor || "Something unnamed"} at ${d.ip}`, url: `./#lan:${d.ip}`, tag: `new-${d.mac}` });
  }
  knownMacs = new Set([...(knownMacs || []), ...macs]);
}
function saveBaseline() {
  if (!baseline.dirty) return;
  try {
    fs.writeFileSync(BASE_FILE + ".tmp", JSON.stringify(baseline.d));
    fs.renameSync(BASE_FILE + ".tmp", BASE_FILE); baseline.dirty = false;
  } catch (e) { console.error("baseline:", e.message); }
}
setInterval(() => { const f = baseline.tick(); if (f.length) { unusualChanged = true; queueAlerts(f); } saveBaseline(); }, 60000);
// Fills in what Pi-hole saw while Huginn was off (up to a week back), from Pi-hole's own disk.
async function backfillBaseline(client, until) {
  const from = Math.max(Math.floor(baseline.d.lastT || 0) + 1, Math.floor(Date.now() / 1000) - 7 * 86400);
  let n = 0;
  backfilling = true;
  try {
  for (let h = from; h < until; h += 3600) {
    const to = Math.min(h + 3600, until);
    for (let start = 0; ; start += 20000) {
      const j = await client.get(`/api/queries?from=${h}&until=${to}&length=20000&start=${start}&disk=true`);
      const qs = (j.queries || []).map(toLookup).filter(Boolean).filter((l) => l.t >= h && l.t < to).sort((a, b) => a.t - b.t);
      learnLookups(qs); n += qs.length;
      if ((j.queries || []).length < 20000) break;
    }
  }
  } finally { backfilling = false; learnLookups(heldLive); heldLive = []; }
  unusualChanged = true; saveBaseline();
  console.log(`Unusual: learned from ${n} lookups Pi-hole kept on disk`);
}

// ---------- Zones: Pi-hole groups, changed only after a preview and a tap ----------
let admin = null, zoneQueue = Promise.resolve();
function piholeAdmin() {
  if (admin) return admin;
  const secret = readJson("pihole.local.json");
  if (!CONFIG.piholeUrl || !secret.appPassword) throw new Error("Pi-hole isn't set up, so zones can't be changed yet.");
  admin = new PiholeAdmin({ url: CONFIG.piholeUrl, password: secret.appPassword });
  return admin;
}
function deviceNames() {
  const out = {};
  for (const d of state.devices) if (d.mac) out[d.mac] = d.name || d.vendor || d.ip;
  return out;
}
function zonesView(z = readZones()) { return { zones: Z.ZONES, members: z.members, journal: z.journal.slice(-30) }; }
function oneAtATime(fn) { const p = zoneQueue.then(fn, fn); zoneQueue = p.catch(() => {}); return p; }

// ---------- Streaming to the screen ----------
const clients = new Set();
function send(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}

function vitals() {
  const netBaseline = median(state.netMs.slice(0, -5));
  return {
    capture: state.capture, iface: state.iface, gateway: state.gateway, pihole: state.pihole, piholeIp: state.piholeIp,
    down: state.down, up: state.up, peakDown: state.peakDown, peakUp: state.peakUp,
    routerMs: state.routerMs.slice(-60), netMs: state.netMs.slice(-60), netBaseline,
    line: assessLine({ routerMs: state.routerMs, netMs: state.netMs, netBaseline,
      downBps: state.down, upBps: state.up, peakDownBps: state.peakDown, peakUpBps: state.peakUp,
      topTalker: flows.topTalker() }),
    total: flows.total,
  };
}

function hello() {
  return { devices: state.devices, subnets: state.subnets, scan: state.scan, hosts: flows.hostList(), lan: flows.lanList(),
           lookups: flows.lookupList(), piholeIp: state.piholeIp,
           series: flows.series, vitals: vitals(), localIps: [...flows.local], historyFrom: historyOldest, house: readHouse(), zones: zonesView(), unusual: baseline.view(), site: SITE, muninn, enumer: { running: enumState.running, results: enumState.results }, deeplook: { available: !!NMAP, running: deepLook.running, results: deepLook.results },
           guestWifi: CONFIG.guestWifi || null };
}

let lastSentT = 0;
setInterval(() => {
  const now = Date.now() / 1000;
  if (Math.floor(now) !== flows.sec.t && flows.sec.t) flows.roll(Math.floor(now));
  const { sparks, seen, all } = flows.drainSparks(90);
  const looks = releaseLookups(now);
  history.add(all); history.add(looks);
  if (clients.size) send("tick", { sparks: sparks.concat(looks), seen, now });
}, 100);
setInterval(() => {
  if (!clients.size) return;
  const fresh = flows.series.filter((s) => s.t > lastSentT);
  if (fresh.length) lastSentT = fresh[fresh.length - 1].t;
  send("vitals", { ...vitals(), sec: fresh });
}, 1000);
setInterval(() => {
  history.learn(flows.hostList());
  flows.prune(Date.now() / 1000);
  if (clients.size) send("hosts", { hosts: flows.hostList(), lan: flows.lanList(), lookups: flows.lookupList() });
  if (unusualChanged && clients.size) { unusualChanged = false; send("unusual", baseline.view()); }
}, 2000);
setInterval(async () => { await loadDevices(); alertNewDevices(); if (clients.size) send("devices", { devices: state.devices, subnets: state.subnets }); }, 30000);

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
                ".webmanifest": "application/manifest+json" };

// ---------- The few things the page may change ----------
// JSON only (a form on another website can't send that without the browser asking first),
// same origin only, small bodies only.
function readBody(req, limit = 4096) {   // the floor plan route allows 64 KB
  return new Promise((resolve, reject) => {
    let size = 0, data = "";
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("too big")); req.destroy(); } else data += c; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
async function handlePost(req, res, pathname) {
  if (pathname === "/api/house/asset") return uploadAsset(req, res);
  if (!/^application\/json(;|$)/i.test(req.headers["content-type"] || "")) return json(res, 415, { error: "JSON only." });
  const origin = req.headers.origin;
  if (origin) {
    let host = null; try { host = new URL(origin).host; } catch { /* bad origin */ }
    if (host !== req.headers.host && host !== (req.headers["x-forwarded-host"] || "")) return json(res, 403, { error: "Not from Huginn's own page." });
  }
  let body = {};
  try { body = JSON.parse((await readBody(req, pathname === "/api/house" ? 65536 : 4096)) || "{}"); } catch { return json(res, 400, { error: "That wasn't readable." }); }

  if (pathname === "/api/devices/label") {
    const c = checkRename(body);
    if (!c.ok) return json(res, 400, { error: c.error });
    if (c.label != null) {
      try {
        const r = await fetch(`${ODIN}/api/devices/label`, {
          method: "POST", headers: ODIN_POST,
          body: JSON.stringify({ mac: c.mac, label: c.label }), signal: AbortSignal.timeout(5000),
        });
        if (r.status === 404) return json(res, 404, { error: "Odin's Watch doesn't know that device yet. Scan first." });
        if (!r.ok) return json(res, 502, { error: `Odin's Watch couldn't save the name (${r.status}).` });
      } catch { return json(res, 502, { error: "Odin's Watch didn't answer, so the name wasn't saved." }); }
    }
    if (c.icon != null) { const meta = readMeta(); meta[c.mac] = { ...(meta[c.mac] || {}), icon: c.icon }; writeMeta(meta); }
    await loadDevices();
    send("devices", { devices: state.devices, subnets: state.subnets });
    return json(res, 200, { saved: true, device: state.devices.find((d) => d.mac === c.mac) || null });
  }
  if (pathname === "/api/devices/link") {
    const c = checkLink(body);
    if (!c.ok) return json(res, 400, { error: c.error });
    const meta = readMeta(); meta[c.mac] = { ...(meta[c.mac] || {}) };
    if (c.link) meta[c.mac].link = c.link; else delete meta[c.mac].link;
    writeMeta(meta); await loadDevices();
    send("devices", { devices: state.devices, subnets: state.subnets });
    return json(res, 200, { saved: true });
  }
  if (pathname === "/api/scan") return json(res, 200, await startScan());
  if (pathname === "/api/house") {
    const c = checkHouse(body);
    if (!c.ok) return json(res, 400, { error: c.error });
    try { writeHouse(c.house); tidyAssets(c.house); } catch { return json(res, 500, { error: "Couldn't save the floor plan." }); }
    send("house", c.house);
    return json(res, 200, { saved: true, house: c.house });
  }
  if (pathname === "/api/zones/plan" || pathname === "/api/zones/move") {
    const c = Z.checkMoves(body);
    if (!c.ok) return json(res, 400, { error: c.error });
    try {
      return await oneAtATime(async () => {
        const z = readZones(), names = deviceNames();
        if (pathname === "/api/zones/plan") return json(res, 200, await Z.planMoves(piholeAdmin(), c.moves, z, names));
        const entry = await Z.applyMoves(piholeAdmin(), c.moves, z, names);
        writeZones(z); send("zones", zonesView(z));
        return json(res, entry.error ? 207 : 200, { entry, error: entry.error });
      });
    } catch (e) { return json(res, 502, { error: e.message }); }
  }
  if (pathname === "/api/unusual/normal" || pathname === "/api/unusual/seen") {
    const fid = String(body.id || "");
    const r = pathname === "/api/unusual/normal" ? baseline.markNormal(fid, body.scope === "house" ? "house" : "device") : baseline.markSeen(fid);
    if (!r.ok) return json(res, 400, { error: r.error });
    saveBaseline(); send("unusual", baseline.view());
    return json(res, 200, { ok: true });
  }
  if (pathname === "/api/push/subscribe") {
    const c = checkSub(body.sub);
    if (!c.ok) return json(res, 400, { error: c.error });
    push.add(c.sub);
    return json(res, 200, { on: true });
  }
  if (pathname === "/api/push/unsubscribe") { push.remove(String(body.endpoint || "")); return json(res, 200, { on: false }); }
  if (pathname === "/api/push/test") {
    if (!push.subs.length) return json(res, 400, { error: "No phone has alerts turned on." });
    const r = await push.send({ title: "Huginn", body: "Alerts work. This is how unusual activity and new devices will reach you.", url: "./#unusual", tag: "test" });
    if (!r.sent) return json(res, 502, { error: r.failed.map((x) => x.error).join(", ") || "Not sent." });
    return json(res, 200, { sent: r.sent });
  }
  if (pathname === "/api/enumerate") {
    const c = checkDeepLook(body, state.devices, state.subnets);   // same local-target-only guard
    if (!c.ok) return json(res, 400, { error: c.error });
    const r = await runEnumerate(c.ip);
    return json(res, r.error ? 502 : 200, r);
  }
  if (pathname === "/api/deeplook") {
    const c = checkDeepLook(body, state.devices, state.subnets);
    if (!c.ok) return json(res, 400, { error: c.error });
    const r = await runDeepLook(c.ip, c.os);
    return json(res, r.error ? 502 : 200, r);
  }
  if (pathname === "/api/zones/undo") {
    try {
      return await oneAtATime(async () => {
        const z = readZones(), r = await Z.undoEntry(piholeAdmin(), String(body.id || ""), z);
        if (!r.ok) return json(res, 400, { error: r.error });
        writeZones(z); send("zones", zonesView(z));
        return json(res, 200, { entry: r.entry });
      });
    } catch (e) { return json(res, 502, { error: e.message }); }
  }
  return json(res, 404, { error: "Not found" });
}

// A picture or 3D model for the floor plan. Raw bytes, not a form, so another website can't post one
// without the browser asking first; and it must come from Huginn's own page.
async function uploadAsset(req, res) {
  const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (!UPLOAD_TYPES.includes(type)) return json(res, 415, { error: "Pictures (PNG, JPG, WebP) or 3D models (.glb) only." });
  let host = null; try { host = new URL(req.headers.origin || "").host; } catch { /* no origin */ }
  if (!host || (host !== req.headers.host && host !== (req.headers["x-forwarded-host"] || ""))) return json(res, 403, { error: "Not from Huginn's own page." });
  let buf;
  try { buf = await readRaw(req, 50 * 1024 * 1024); } catch { return json(res, 413, { error: "That file is over 50 MB." }); }
  const kind = sniffAsset(buf);
  if (!kind) return json(res, 400, { error: "That isn't a PNG, JPG or WebP picture, or a .glb 3D model." });
  if (kind !== "glb" && buf.length > 15 * 1024 * 1024) return json(res, 413, { error: "Pictures can be 15 MB at most." });
  const name = crypto.randomBytes(6).toString("hex") + "." + kind;
  try { fs.mkdirSync(ASSET_DIR, { recursive: true }); fs.writeFileSync(path.join(ASSET_DIR, name), buf); }
  catch { return json(res, 500, { error: "Couldn't save the file." }); }
  return json(res, 200, { file: name, kind, size: buf.length });
}

// Huginn answers only to its own names. A web page elsewhere can point a name of its own at this PC
// (DNS rebinding) and then read the network map or post changes as if it were Huginn's page; checking
// the Host header stops that. Tailscale names are safe to allow: only Tailscale controls their DNS.
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
function hostAllowed(h) {
  if (!h) return false;
  const name = String(h).toLowerCase().replace(/:\d+$/, "");
  if (LOOPBACK.has(name) || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(name)) return true;
  return (CONFIG.allowedHosts || []).some((a) => String(a).toLowerCase() === name);
}

const server = http.createServer((req, res) => {
  if (!hostAllowed(req.headers.host) || (req.headers["x-forwarded-host"] && !hostAllowed(req.headers["x-forwarded-host"]))) {
    console.error("refused a request for host", String(req.headers.host).slice(0, 80));
    res.writeHead(421, { "Content-Type": "text/plain" }); return res.end("Huginn only answers to its own address.");
  }
  // Only the path matters. Parse it defensively: "//host" or bad escapes must not crash the server.
  let pathname;
  try { pathname = decodeURIComponent(String(req.url || "/").split("?")[0]).replace(/^\/+/, "/"); }
  catch { res.writeHead(400); return res.end(); }
  const url = { pathname };
  if (req.method === "POST") {   // a surprise inside a change must answer with an error, not take Huginn down
    return handlePost(req, res, url.pathname).catch((e) => {
      console.error("POST", url.pathname, e && e.message);
      if (!res.headersSent) json(res, 500, { error: "Huginn hit a problem with that. Nothing was changed by it." }); else res.end();
    });
  }
  if (url.pathname === "/api/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`event: hello\ndata: ${JSON.stringify(hello())}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (url.pathname === "/download/huginn.apk") {   // the Android app, built by app/ (npm run apk there)
    const apk = path.join(DATA, "app", "huginn.apk");
    return fs.stat(apk, (e, st) => {
      if (e) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("The app hasn't been built yet."); }
      res.writeHead(200, { "Content-Type": "application/vnd.android.package-archive", "Content-Length": st.size,
                           "Content-Disposition": 'attachment; filename="huginn.apk"' });
      fs.createReadStream(apk).pipe(res);
    });
  }
  if (url.pathname === "/api/house") return json(res, 200, readHouse());
  if (url.pathname.startsWith("/api/house/asset/")) {
    const name = url.pathname.slice("/api/house/asset/".length);
    if (!ASSET.test(name)) { res.writeHead(404); return res.end(); }
    const file = path.join(ASSET_DIR, name);
    return fs.stat(file, (e, st) => {
      if (e) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": ASSET_TYPES[name.split(".").pop()], "Content-Length": st.size,
                           "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" });
      fs.createReadStream(file).pipe(res);
    });
  }
  if (url.pathname === "/api/zones") return json(res, 200, zonesView());
  if (url.pathname === "/api/push/key") return json(res, 200, { publicKey: push.keys.publicKey, phones: push.subs.length });
  if (url.pathname === "/api/history") {
    const q = new URLSearchParams(String(req.url).split("?")[1] || "");
    const from = Number(q.get("from")), until = Number(q.get("until"));
    if (!Number.isFinite(from) || !Number.isFinite(until)) return json(res, 400, { error: "from and until are needed." });
    try { history.flush(8); } catch { /* best effort */ }
    return json(res, 200, { ...history.read(from, until), oldest: historyOldest });
  }
  const file = path.normalize(path.join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }   // a sibling like public2 must not pass either
  fs.readFile(file, (e, buf) => {
    if (e) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
});

(async () => {
  await loadDevices(); alertNewDevices(); try { loadMuninn(); } catch { /* no reports yet */ }   // remembers who is here now, so only later arrivals alert
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") console.log(`Huginn is already running: open http://127.0.0.1:${PORT}`);
    else console.error(e.message);
    process.exit(e.code === "EADDRINUSE" ? 0 : 1);
  });
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Huginn command center: http://127.0.0.1:${PORT}`);
    startSniffer(); startSpeed(); pingLoop(); portsLoop(); ptrLoop(); piholeLoop();
  });
})();
