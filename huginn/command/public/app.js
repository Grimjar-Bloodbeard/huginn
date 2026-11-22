// Huginn command center: the live sky chart.
// Router in the middle, house devices on the inner ring, the internet on the
// outer ring grouped by owner. Every packet becomes a spark. Pinch, scroll or
// drag to move around; more detail shows as you zoom in.
"use strict";

const COLORS = {
  out: "#FFB45C", in: "#86D6FF", dns: "#B693FF", lan: "#7FE0B4", chatter: "#8E97B8", cast: "#8E97B8",
  blocked: "#FF5D73", bone: "#E9E5D9", dim: "#A9AEC2", faint: "#6B7495", line: "#2B3B63",
  sky: "#0F1830", deep: "#0A1124", ember: "#FFB45C", moss: "#7FE0B4",
};
const KIND_WORD = { out: "→", in: "←", dns: "?", lan: "↔", chatter: "·", cast: "·", blocked: "✕" };
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const NEW_FOR_SEC = 48 * 3600; // a device counts as new for two days, until it's named

// ---------- data ----------
const S = {
  devices: new Map(),     // ip -> device (Odin's Watch + Huginn's icon)
  macs: null,             // hardware addresses seen so far (null until the first list)
  subnets: [],
  hosts: new Map(),       // internet ip -> host stats
  lan: new Map(),         // lan ip -> what this PC heard
  lookups: new Map(),     // device ip -> what it looked up (Pi-hole)
  piholeIp: null,
  series: [],
  vitals: null,
  localIps: new Set(),
  gateway: null,
  paused: false,
  selected: null,
  highlight: new Set(),
  watch: null,            // when set: { org } - spotlight one service's packets on the map
};

// ---------- formatting ----------
function fmtBytes(b) {
  if (b < 1024) return `${Math.round(b)} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}
function mbps(bps) {
  const v = (bps * 8) / 1e6;
  return v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v).toString();
}
function ago(sec) {
  if (!sec) return "never";
  const d = Date.now() / 1000 - sec;
  if (d < 5) return "just now";
  if (d < 60) return `${Math.round(d)} s ago`;
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400 * 2) return `${Math.round(d / 3600)} h ago`;
  return `${Math.round(d / 86400)} days ago`;
}
function clock(sec, withMs) {
  const d = new Date(sec * 1000);
  const s = d.toLocaleTimeString([], { hour12: false });
  return withMs ? `${s}.${String(d.getMilliseconds()).padStart(3, "0")}` : s;
}
function day(sec) { return sec ? new Date(sec * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "unknown"; }
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }
const PORT_NAMES = { 22: "SSH", 53: "DNS", 67: "DHCP", 80: "Web", 123: "Time", 137: "Windows names", 443: "Web (secure)",
  445: "Windows files", 1900: "Device discovery", 3074: "Xbox Live", 3389: "Remote desktop", 3478: "Calls / voice",
  5353: "Device discovery", 5355: "Windows names", 8080: "Web", 8009: "Cast", 41641: "Tailscale" };
function service(port, proto) {
  if (proto === "udp" && port === 443) return "QUIC";
  return PORT_NAMES[port] || (port ? `${port}/${proto}` : proto);
}
function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619); return (h >>> 0) / 4294967296; }
function realName(n) { return n && !/^unknown$/i.test(n) ? n : null; }
function deviceName(d) { return d ? realName(d.name) || d.vendor || d.ip : null; }
function hostName(h) { return h.name || h.ip; }
function isNew(d) { return !!d && !d.label && d.firstSeen && Date.now() / 1000 - d.firstSeen < NEW_FOR_SEC; }
function isGuest(d) { return !!d && (d.role === "iot" || d.role === "guest"); }
// What you named this PC (in Devices), else "This PC".
function myName() { for (const ip of S.localIps) { const d = S.devices.get(ip); if (d && d.label) return d.label; } return "This PC"; }
function isLanIp(ip) { return /^192\.168\.|^10\./.test(ip); }
function nodeLabel(key) {
  if (key === "pc") return myName();
  if (key === "router") return "Router";
  if (key === "cast") return "Everyone (broadcast)";
  const i = key.indexOf(":"), kind = key.slice(0, i), ip = key.slice(i + 1);
  if (kind === "lan") return ip === S.piholeIp ? "Pi-hole" : deviceName(S.devices.get(ip)) || ip;
  if (kind === "net") { const h = S.hosts.get(ip); return h ? hostName(h) : ip; }
  if (kind === "org") return ip;
  return key;
}

// ---------- icons (24-unit line drawings) ----------
const ICON_PATHS = {
  phone: "M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z M11 18.5h2",
  tablet: "M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z M11 18.5h2",
  computer: "M4 4h16a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 20 16H4a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 4 4z M12 16v4 M8 20h8",
  laptop: "M5 5h14v10H5z M2 19h20",
  tv: "M4 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z M8 3l4 4 4-4",
  console: "M7 8h10a5 5 0 0 1 4.6 7l-.6 1.4a2.5 2.5 0 0 1-4.3.4L15 15H9l-1.7 1.8a2.5 2.5 0 0 1-4.3-.4L2.4 15A5 5 0 0 1 7 8z M7 10.5v3 M5.5 12h3 M16 11h.01 M18 13h.01",
  speaker: "M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z M12 10.5a3.5 3.5 0 1 1 0 7a3.5 3.5 0 1 1 0-7z M12 6h.01",
  camera: "M3 7h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z M16 10.5l6-3.5v10l-6-3.5",
  plug: "M9 2v5 M15 2v5 M6 7h12v4a6 6 0 0 1-12 0z M12 17v5",
  chip: "M7 7h10v10H7z M10 3v4 M14 3v4 M10 17v4 M14 17v4 M3 10h4 M3 14h4 M17 10h4 M17 14h4",
  printer: "M7 9V3h10v6 M5 9h14a2 2 0 0 1 2 2v5h-4 M7 16H3v-5a2 2 0 0 1 2-2 M7 13h10v8H7z",
  router: "M4 13h16a1.5 1.5 0 0 1 1.5 1.5v4A1.5 1.5 0 0 1 20 20H4a1.5 1.5 0 0 1-1.5-1.5v-4A1.5 1.5 0 0 1 4 13z M7 13L5.5 5 M17 13l1.5-8 M7 16.5h.01 M10.5 16.5h.01",
  server: "M5 3h14a1.5 1.5 0 0 1 1.5 1.5v4A1.5 1.5 0 0 1 19 10H5a1.5 1.5 0 0 1-1.5-1.5v-4A1.5 1.5 0 0 1 5 3z M5 14h14a1.5 1.5 0 0 1 1.5 1.5v4A1.5 1.5 0 0 1 19 21H5a1.5 1.5 0 0 1-1.5-1.5v-4A1.5 1.5 0 0 1 5 14z M7.5 6.5h.01 M7.5 17.5h.01",
  watch: "M8 7h8v10H8z M9 7l1-5h4l1 5 M9 17l1 5h4l1-5",
  unknown: "M9.2 9a2.9 2.9 0 1 1 4 2.6c-.8.4-1.2 1-1.2 1.8v.6 M12 17.5h.01",
};
const ICON_WORDS = { phone: "Phone", tablet: "Tablet", computer: "Computer", laptop: "Laptop", tv: "TV", console: "Console",
  speaker: "Speaker", camera: "Camera", plug: "Smart plug", chip: "Gadget", printer: "Printer", router: "Router / AP",
  server: "Server", watch: "Watch", unknown: "Not sure" };
const iconCache = {};
function iconPath(name) { return iconCache[name] || (iconCache[name] = new Path2D(ICON_PATHS[name] || ICON_PATHS.unknown)); }
function iconSvg(name, size = 20) {
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON_PATHS[name] || ICON_PATHS.unknown}"/></svg>`;
}
function drawIcon(name, x, y, size, color, lw) {
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.stroke(iconPath(name));
  ctx.restore();
}

// ---------- canvas + view (zoom and pan) ----------
const sky = document.getElementById("sky");
const ctx = sky.getContext("2d");
let W = 0, H = 0, DPR = 1, CX = 0, CY = 0, R1 = 0, R2 = 0, NARROW = false;
const view = { s: 1, x: 0, y: 0, goal: null };   // screen = world * s + (x, y)

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = innerWidth; H = innerHeight;
  sky.width = W * DPR; sky.height = H * DPR;
  sky.style.width = W + "px"; sky.style.height = H + "px";   // match the buffer to the real viewport (mobile URL bar changes 100vh)
  frame();
  makeStars();
  layout(true);
}
// Work out where the galaxy sits so nothing is hidden behind the real header and nav bar.
// On a phone we measure the actual chrome (which grows with safe-area insets and bigger text)
// instead of guessing, then size the rings so even the outer labels stay on screen.
function frame() {
  NARROW = W < 760;
  if (NARROW) {
    let top = 150, bottom = 150;
    try {
      const vit = document.querySelector(".vitals");
      if (vit && getComputedStyle(vit).display !== "none") { const r = vit.getBoundingClientRect(); if (r.height > 0) top = r.bottom + 12; }
      const foot = document.querySelector(".timeline");
      if (foot) { const r = foot.getBoundingClientRect(); if (r.height > 0) bottom = H - r.top + 10; }
    } catch (e) {}
    top = Math.max(76, Math.min(top, H * 0.42));
    bottom = Math.max(88, Math.min(bottom, H * 0.46));
    const avail = H - top - bottom;
    CX = W / 2; CY = top + avail / 2;
    const half = Math.min(W - 16, avail) / 2;
    const labelPad = 50;   // room for the outer-ring labels so they don't clip
    R2 = Math.max(64, half - labelPad);
    R1 = R2 * 0.57;
  } else {
    const left = W < 1100 ? 330 : 420;
    CX = left + (W - left) / 2; CY = H * 0.45;
    const m = Math.min((W - left) * 0.92, H * 0.72);
    R1 = m * 0.22; R2 = m * 0.44;
  }
}
addEventListener("resize", resize);

function toWorld(sx, sy) { return [(sx - view.x) / view.s, (sy - view.y) / view.s]; }
function zoomAt(sx, sy, factor) {
  const s2 = Math.min(8, Math.max(0.6, view.s * factor));
  view.x = sx - (sx - view.x) * (s2 / view.s);
  view.y = sy - (sy - view.y) * (s2 / view.s);
  view.s = s2; view.goal = null;
  layoutSoon();
}
function flyTo(wx, wy, s) {
  view.goal = { s, x: W / 2 - wx * s, y: (NARROW ? H * 0.42 : H / 2) - wy * s };
  layoutSoon();
}
function fit() { view.goal = { s: 1, x: 0, y: 0 }; layoutSoon(); }

let stars = [];
function makeStars() {
  stars = [];
  const n = Math.round((W * H) / 9000);
  for (let i = 0; i < n; i++) stars.push({ x: Math.random() * W, y: Math.random() * H, r: Math.random() * 0.9 + 0.2, a: Math.random() * 0.35 + 0.05, tw: Math.random() * 6.28, d: Math.random() });
}

// ---------- layout ----------
const nodes = new Map();
const orgOrder = [];
const orgs = new Map();
const bursts = [];   // rings: new devices arriving, blocked lookups popping

function node(key, kind) {
  let n = nodes.get(key);
  if (!n) { n = { key, kind, x: CX, y: CY, tx: CX, ty: CY, r: 4, flash: 0, heat: 0, alive: true }; nodes.set(key, n); }
  n.alive = true; n.kind = kind;
  return n;
}
function place(n, x, y, snap) { n.tx = x; n.ty = y; if (snap) { n.x = x; n.y = y; } }

let layoutTimer = null;
function layoutSoon() { clearTimeout(layoutTimer); layoutTimer = setTimeout(() => layout(false), 120); }

function lanList() {
  const ips = new Set();
  for (const d of S.devices.values()) if (d.ip && d.ip !== S.gateway && !S.localIps.has(d.ip)) ips.add(d.ip);
  // Only addresses that said something back count. Odin's Watch pings every address; the empty ones stay off.
  for (const [ip, l] of S.lan) if (isLanIp(ip) && ip !== S.gateway && !S.localIps.has(ip) && (l.in > 0 || l.chatter > 0)) ips.add(ip);
  const rank = (ip) => (isGuest(S.devices.get(ip)) ? 1 : 0);
  return [...ips].sort((a, b) => rank(a) - rank(b) ||
    ((S.devices.get(a) || {}).icon || "z").localeCompare((S.devices.get(b) || {}).icon || "z") ||
    a.localeCompare(b, undefined, { numeric: true }));
}

function layout(snap = false) {
  frame();
  for (const n of nodes.values()) n.alive = false;
  const router = node("router", "router"); place(router, CX, CY, snap); router.r = NARROW ? 10 : 12;
  const cast = node("cast", "cast"); place(cast, CX - R1 * 0.4, CY - R1 * 0.36, snap); cast.r = 3.5;

  const list = lanList();
  const pc = node("pc", "pc"); place(pc, CX, CY + R1, snap); pc.r = NARROW ? 9 : 11;
  const keepClear = 0.5;
  const za = S.zonesOn && S.view !== "house" ? zoneAngles(list) : null;   // zones.js: one slice per zone
  list.forEach((ip, i) => {
    const t = list.length === 1 ? 0.5 : i / (list.length - 1);
    const a = za ? za.get(ip) : Math.PI / 2 + keepClear + t * (Math.PI * 2 - 2 * keepClear);
    const key = `lan:${ip}`;
    const fresh = !nodes.has(key);
    const n = node(key, "lan");
    const wob = (hash(ip) - 0.5) * R1 * 0.14;
    const tx = CX + Math.cos(a) * (R1 + wob), ty = CY + Math.sin(a) * (R1 + wob);
    if (fresh && !snap) { n.x = CX + Math.cos(a) * R2 * 1.5; n.y = CY + Math.sin(a) * R2 * 1.5; } // flies in
    place(n, tx, ty, snap && !n.arriving);
    const d = S.devices.get(ip);
    n.r = d ? (NARROW ? 8 : 9.5) : 5;
    n.angle = a;
    n.offline = d && d.status && /off|gone|away/i.test(d.status);
  });

  // Outer ring: the internet, grouped by owner. Zooming in shows more hosts per owner.
  const now = Date.now() / 1000;
  const byOrg = new Map();
  for (const h of S.hosts.values()) {
    const o = h.org || "Unknown websites";
    if (!byOrg.has(o)) byOrg.set(o, []);
    byOrg.get(o).push(h);
  }
  for (const o of byOrg.keys()) if (!orgOrder.includes(o)) orgOrder.push(o);
  for (let i = orgOrder.length - 1; i >= 0; i--) if (!byOrg.has(orgOrder[i])) orgOrder.splice(i, 1);
  const weights = orgOrder.map((o) => {
    const hs = byOrg.get(o);
    const bytes = hs.reduce((s, h) => s + h.in + h.out, 0);
    return (1.2 + Math.sqrt(bytes) / 120) * (hs.some((h) => now - h.last < 30) ? 1 : 0.6);
  });
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const gap = Math.min(0.05, (Math.PI * 2 * 0.18) / Math.max(1, orgOrder.length));
  const usable = Math.PI * 2 - gap * orgOrder.length;
  let a0 = -Math.PI / 2 - (usable * (weights[0] || 0) / total) / 2;
  orgs.clear();
  const spacing = (NARROW ? 0.09 : 0.04) / Math.min(4, view.s);
  orgOrder.forEach((o, i) => {
    const span = usable * (weights[i] / total);
    const mid = a0 + span / 2;
    const hs = byOrg.get(o).sort((x, y) => (y.in + y.out) - (x.in + x.out));
    const shown = hs.slice(0, Math.max(NARROW ? 1 : 3, Math.floor(span / spacing)));
    const on = node(`org:${o}`, "org");
    place(on, CX + Math.cos(mid) * (R2 + 18), CY + Math.sin(mid) * (R2 + 18), snap);
    on.angle = mid; on.r = 0;
    orgs.set(o, { key: on.key, angle: mid, span, start: a0, hosts: shown, all: hs, bytes: hs.reduce((s, h) => s + h.in + h.out, 0) });
    shown.forEach((h, j) => {
      const t = shown.length === 1 ? 0.5 : j / (shown.length - 1);
      const a = a0 + span * (0.12 + 0.76 * t);
      const row = (hash(h.ip) - 0.5) * (NARROW ? 14 : 26);
      const n = node(`net:${h.ip}`, "net");
      place(n, CX + Math.cos(a) * (R2 + row), CY + Math.sin(a) * (R2 + row), snap && !n.seen);
      n.seen = true;
      n.r = 2 + Math.min(4.5, Math.log10(1 + h.in + h.out) * 0.7);
      n.org = o; n.angle = a;
    });
    for (const h of hs.slice(shown.length)) { const n = node(`net:${h.ip}`, "net-hidden"); place(n, on.tx, on.ty, snap); n.org = o; }
    a0 += span + gap;
  });
  for (const [k, n] of nodes) if (!n.alive && k !== "pc" && k !== "router" && k !== "cast") nodes.delete(k);
  if (S.view === "house") houseLayout(snap);   // house.js: the floor plan moves everything into rooms
}
setInterval(() => { if (!hover && !S.selected && !pointers.size) layout(false); }, 5000);

// ---------- sparks ----------
const sparks = [];
const watchStat = { bytes: 0, sparks: 0, lastTotal: 0, rate: 0 };   // live tally while watching one service
const MAX_SPARKS = reduceMotion ? 0 : 220;   // calm: a sky you can read, not a blizzard
function provisional(key) {
  if (!key.startsWith("net:") || nodes.has(key)) return nodes.get(key);
  const a = hash(key) * Math.PI * 2, n = node(key, "net");
  place(n, CX + Math.cos(a) * R2, CY + Math.sin(a) * R2, true); n.r = 2.5;
  return n;
}
function routeFor(s) {
  const a = provisional(s.s), b = provisional(s.d);
  if (!a || !b) return null;
  if (s.k === "out" || s.k === "in" || (s.k === "dns" && (s.s.startsWith("net:") || s.d.startsWith("net:")))) return [a, nodes.get("router"), b];
  return [a, b];
}
function addSparks(list) {
  if (window.holoSparks) window.holoSparks(list);   // the 3D view gets the same packets
  if (S.paused || !list.length) return;
  const base = performance.now(), t0 = list[0].t;
  // One spark per path and kind in each tick, carrying the bytes of all its packets.
  const merged = new Map();
  for (const s of list) {
    const key = s.s + "|" + s.d + "|" + s.k, m = merged.get(key);
    if (m) m.b += s.b; else merged.set(key, { ...s });
  }
  for (const s of merged.values()) {
    if (sparks.some((o) => o.key === s.s + "|" + s.d + "|" + s.k && base - o.born < 600)) continue; // that path is already lit

    if (sparks.length >= MAX_SPARKS) break;
    const route = routeFor(s);
    if (!route) continue;
    let len = 0;
    for (let i = 1; i < route.length; i++) len += Math.hypot(route[i].tx - route[i - 1].tx, route[i].ty - route[i - 1].ty);
    const netKey = s.s.startsWith("net:") ? s.s : (s.d.startsWith("net:") ? s.d : null);
    const netHost = netKey ? S.hosts.get(netKey.slice(4)) : null;
    sparks.push({ key: s.s + "|" + s.d + "|" + s.k, route, kind: s.k, b: s.b, born: base + Math.max(0, Math.min(100, (s.t - t0) * 1000)), dur: 1300 + len * 2.6,
                  size: 1.1 + Math.min(3.2, Math.log2(1 + s.b) / 3.4), bend: (hash(s.s + s.d) - 0.5) * 0.5,
                  org: netHost ? netHost.org : null });
    if (S.watch && netHost && netHost.org === S.watch.org) { watchStat.bytes += s.b; watchStat.sparks++; }
  }
}
function pointOn(route, p, bend) {
  const segs = route.length - 1, f = Math.min(segs - 1e-6, p * segs), i = Math.floor(f), u = f - i;
  const A = route[i], B = route[i + 1];
  const dx = B.x - A.x, dy = B.y - A.y;
  const cx = (A.x + B.x) / 2 - dy * bend * 0.35, cy = (A.y + B.y) / 2 + dx * bend * 0.35;
  const v = 1 - u;
  return [v * v * A.x + 2 * v * u * cx + u * u * B.x, v * v * A.y + 2 * v * u * cy + u * u * B.y];
}
function ease(p) { return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; }

// ---------- drawing ----------
let hover = null;
function font(weight, px) { return `${weight} ${px}px 'Schibsted Grotesk', system-ui`; }

function draw(ts) {
  requestAnimationFrame(draw);
  if (S.view === "holo") return;   // the 3D view draws itself (holo.js)
  if (view.goal) {
    const g = view.goal, k = 0.14;
    view.s += (g.s - view.s) * k; view.x += (g.x - view.x) * k; view.y += (g.y - view.y) * k;
    if (Math.abs(g.s - view.s) < 0.002 && Math.abs(g.x - view.x) < 0.5 && Math.abs(g.y - view.y) < 0.5) { Object.assign(view, g); view.goal = null; layoutSoon(); }
  }
  const s = view.s, k = 1 / s, zr = Math.pow(s, -0.55);

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);
  for (const st of stars) {   // a little parallax: far stars barely move
    const a = reduceMotion ? st.a : st.a * (0.75 + 0.25 * Math.sin(ts / 1700 + st.tw));
    const px = ((st.x + view.x * 0.04 * st.d) % W + W) % W, py = ((st.y + view.y * 0.04 * st.d) % H + H) % H;
    ctx.fillStyle = `rgba(233,229,217,${a})`;
    ctx.fillRect(px, py, st.r, st.r);
  }
  ctx.setTransform(DPR * s, 0, 0, DPR * s, DPR * view.x, DPR * view.y);

  for (const n of nodes.values()) { n.x += (n.tx - n.x) * 0.08; n.y += (n.ty - n.y) * 0.08; n.flash *= 0.95; n.heat *= 0.985; }

  if (S.view === "house") drawHouse(s, k); else {
  // rings and captions
  ctx.lineWidth = k;
  ctx.strokeStyle = "rgba(43,59,99,0.6)"; ctx.setLineDash([2 * k, 6 * k]);
  ctx.beginPath(); ctx.arc(CX, CY, R1, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]); ctx.strokeStyle = "rgba(43,59,99,0.3)";
  ctx.beginPath(); ctx.arc(CX, CY, R2, 0, Math.PI * 2); ctx.stroke();
  ctx.font = `italic 500 ${11 * k}px 'Schibsted Grotesk', system-ui`;
  ctx.fillStyle = COLORS.faint; ctx.textAlign = "left";
  if (!NARROW || s > 1.3) {
    ctx.fillText(S.site ? "inside the network" : "inside the house", CX - R1 + 22 * k, CY + 4 * k);
    ctx.fillText("the internet", CX - R2 + 22 * k, CY + 4 * k);
  }

  if (S.zonesOn) drawZoneSectors(s, k);
  // owner arcs
  if (!S.simple) for (const g of orgs.values()) {
    const on = nodes.get(g.key), heat = on ? Math.min(1, on.heat / 40000) : 0;
    const sel = S.selected === g.key || S.highlight.has(g.key);
    if (g.span < 0.03 && !sel && heat < 0.05) continue;
    const pad = Math.min(0.02, g.span * 0.2);
    ctx.strokeStyle = sel ? "rgba(233,229,217,0.85)" : `rgba(134,214,255,${0.12 + heat * 0.7})`;
    ctx.lineWidth = (sel ? 2.5 : 1 + heat * 3) * k; ctx.lineCap = "round";
    ctx.beginPath(); ctx.arc(CX, CY, R2 + 18, g.start + pad, g.start + g.span - pad); ctx.stroke();
    ctx.lineCap = "butt";
    if (on && on.heat >= 200) {
      ctx.strokeStyle = `rgba(255,180,92,${Math.min(0.35, on.heat / 120000)})`; ctx.lineWidth = k;
      ctx.beginPath(); ctx.moveTo(CX, CY); ctx.lineTo(CX + Math.cos(g.angle) * R2, CY + Math.sin(g.angle) * R2); ctx.stroke();
    }
  }

  }
  const pc = nodes.get("pc"), router = nodes.get("router");
  ctx.strokeStyle = "rgba(233,229,217,0.18)"; ctx.lineWidth = 1.5 * k;
  ctx.beginPath(); ctx.moveTo(pc.x, pc.y); ctx.lineTo(router.x, router.y); ctx.stroke();

  // sparks
  const t = performance.now();
  ctx.globalCompositeOperation = "lighter";
  for (let i = sparks.length - 1; i >= 0; i--) {
    const sp = sparks[i], p = (t - sp.born) / sp.dur;
    if (p < 0) continue;
    if (p >= 1) {
      const end = sp.route[sp.route.length - 1];
      end.flash = Math.min(0.7, end.flash + 0.15); end.heat += sp.b;
      const og = end.org && nodes.get(`org:${end.org}`); if (og) og.heat += sp.b;
      if (sp.kind === "blocked") bursts.push({ node: end, born: t, color: COLORS.blocked, dur: 700, size: 18 });
      sparks.splice(i, 1); continue;
    }
    if (S.simple && sp.route.some((n) => n.kind === "net")) continue;   // Simple view: only what happens inside the house
    const watched = S.watch ? sp.org === S.watch.org : null;
    if (watched === false) {   // spotlight on another service: fade everything else right down
      const q0 = ease(p), [dx, dy] = pointOn(sp.route, q0, sp.bend);
      ctx.globalAlpha = 0.07; ctx.fillStyle = COLORS[sp.kind] || COLORS.bone;
      ctx.beginPath(); ctx.arc(dx, dy, sp.size * zr * 0.8, 0, Math.PI * 2); ctx.fill();
      continue;
    }
    const q = ease(p);
    const [x, y] = pointOn(sp.route, q, sp.bend), [x2, y2] = pointOn(sp.route, Math.max(0, q - (watched ? 0.11 : 0.05)), sp.bend);
    const c = COLORS[sp.kind] || COLORS.bone, sz = sp.size * zr * (watched ? 1.7 : 1);
    ctx.strokeStyle = c; ctx.globalAlpha = watched ? 0.6 : 0.35; ctx.lineWidth = sz * 0.9;
    ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x, y); ctx.stroke();
    ctx.globalAlpha = 0.95; ctx.fillStyle = c;
    ctx.beginPath(); ctx.arc(x, y, sz, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = watched ? 0.3 : 0.18; ctx.beginPath(); ctx.arc(x, y, sz * (watched ? 4.2 : 3.2), 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  for (let i = bursts.length - 1; i >= 0; i--) {
    const b = bursts[i], p = (t - b.born) / b.dur;
    if (p >= 1) { bursts.splice(i, 1); continue; }
    ctx.globalAlpha = 0.85 * (1 - p); ctx.strokeStyle = b.color; ctx.lineWidth = 2 * zr;
    ctx.beginPath(); ctx.arc(b.node.x, b.node.y, (8 + p * b.size) * zr, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";

  const now = Date.now() / 1000;
  for (const n of nodes.values()) drawNode(n, now, s, k, zr, ts);

  // owner labels (constant size on screen)
  ctx.font = font(600, 12.5 * k);
  if (S.view !== "house" && !S.simple) for (const [o, g] of orgs) {
    if (g.span * R2 * s < (NARROW ? 46 : 30) && !(S.selected === g.key || hover === g.key)) continue;
    const lx = CX + Math.cos(g.angle) * (R2 + 34), ly = CY + Math.sin(g.angle) * (R2 + 34);
    const c = Math.cos(g.angle), sn = Math.sin(g.angle);
    ctx.textAlign = c > 0.3 ? "left" : c < -0.3 ? "right" : "center";
    ctx.textBaseline = sn > 0.5 ? "top" : sn < -0.5 ? "bottom" : "middle";
    const busy = nodes.get(g.key);
    ctx.fillStyle = busy && busy.heat > 2000 ? COLORS.bone : COLORS.dim;
    ctx.fillText(o, lx, ly);
  }
  ctx.textBaseline = "alphabetic";
}

function drawNode(n, now, s, k, zr, ts) {
  if (n.kind === "org" || n.kind === "net-hidden") return;
  if (S.simple && n.kind === "net") return;
  const lit = S.selected === n.key || hover === n.key || S.highlight.has(n.key);
  const r = n.r * zr;
  let fill = COLORS.dim, label = null, icon = null, d = null, ip = null;

  if (n.kind === "router") { fill = COLORS.bone; label = "Router"; icon = "router"; }
  else if (n.kind === "pc") { fill = COLORS.ember; label = myName(); icon = "computer"; }
  else if (n.kind === "cast") { fill = COLORS.chatter; }
  else if (n.kind === "lan") {
    ip = n.key.slice(4); d = S.devices.get(ip);
    fill = !d ? COLORS.chatter : n.offline ? "#4A5375" : isGuest(d) ? COLORS.ember : COLORS.moss;
    label = deviceName(d) || ip;
    icon = d ? d.icon : null;
    if (ip === S.piholeIp) { fill = COLORS.dns; label = `Pi-hole (${label})`; icon = "server"; }
  } else if (n.kind === "net") {
    const h = S.hosts.get(n.key.slice(4));
    fill = h && now - h.last < 20 ? COLORS.in : "#4F6A92";
    if (h && s >= 2.4) label = hostName(h);
  }

  if (n.flash > 0.02) {
    ctx.globalCompositeOperation = "lighter"; ctx.fillStyle = fill; ctx.globalAlpha = n.flash * 0.35;
    ctx.beginPath(); ctx.arc(n.x, n.y, r * 3.2, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
  }

  if (S.zonesOn) drawZoneRing(n, d, r, zr);
  if (S.flagged && d && S.flagged.has(d.ip)) drawFlag(n, r, zr, ts);
  // new devices: a slow glowing ring until they're named
  if (d && isNew(d)) {
    const p = reduceMotion ? 0.5 : (Math.sin(ts / 1100) + 1) / 2;
    ctx.strokeStyle = `rgba(255,180,92,${0.35 + p * 0.5})`; ctx.lineWidth = 2 * zr;
    ctx.beginPath(); ctx.arc(n.x, n.y, r + (5 + p * 4) * zr, 0, Math.PI * 2); ctx.stroke();
  }

  if (n.kind === "router") {
    const sweep = reduceMotion ? 0 : performance.now() / 9000;
    ctx.fillStyle = COLORS.deep; ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = COLORS.bone; ctx.lineWidth = 2 * zr;
    ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "rgba(233,229,217,0.35)"; ctx.lineWidth = zr;
    ctx.beginPath(); ctx.arc(n.x, n.y, r + 7 * zr, sweep, sweep + Math.PI * 0.6); ctx.stroke();
    ctx.beginPath(); ctx.arc(n.x, n.y, r + 7 * zr, sweep + Math.PI, sweep + Math.PI * 1.6); ctx.stroke();
    drawIcon("router", n.x, n.y + 0.5 * zr, r * 1.25, COLORS.bone, 2);
  } else if (n.kind === "net" || n.kind === "cast") {
    ctx.fillStyle = fill; ctx.globalAlpha = n.kind === "cast" ? 0.7 : 1;
    ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
  } else {
    ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fill();
    if (icon && r * s >= 6.5) drawIcon(icon, n.x, n.y, r * 1.25, COLORS.deep, 2.2);
    if (n.kind === "pc") { ctx.strokeStyle = "rgba(255,180,92,0.45)"; ctx.lineWidth = zr; ctx.beginPath(); ctx.arc(n.x, n.y, r + 5 * zr, 0, Math.PI * 2); ctx.stroke(); }
  }
  if (lit) { ctx.strokeStyle = COLORS.bone; ctx.lineWidth = 1.5 * zr; ctx.beginPath(); ctx.arc(n.x, n.y, r + 4 * zr, 0, Math.PI * 2); ctx.stroke(); }

  // labels stay the same size on screen; devices get names once there's room
  if (!label) return;
  const named = n.kind !== "lan" || ip === S.piholeIp || !!realName(d && d.name);
  const room = R1 * s;
  const show = n.kind === "router" || n.kind === "pc" || lit || (n.kind === "lan" && named && room > (NARROW ? 190 : 120)) ||
               (n.kind === "lan" && room > 300) || n.kind === "net";
  if (!show || (n.inTray && !lit)) return;
  const isLan = n.kind === "lan" || n.kind === "net";
  ctx.font = font(isLan ? 500 : 700, (isLan ? 11.5 : 13) * k);
  ctx.fillStyle = isLan ? (n.kind === "net" ? COLORS.faint : COLORS.dim) : COLORS.bone;
  let lx = n.x, ly = n.y + r + 15 * k;
  ctx.textAlign = "center";
  if (isLan) {
    const c = Math.cos(n.angle), sn = Math.sin(n.angle), gap = r + 8 * k;
    lx = n.x + c * gap; ly = n.y + sn * gap + 4 * k;
    ctx.textAlign = c > 0.25 ? "left" : c < -0.25 ? "right" : "center";
    if (Math.abs(c) <= 0.25) ly += sn > 0 ? 9 * k : -7 * k;
    label = label.length > 24 ? label.slice(0, 23) + "…" : label;
  }
  if (n.kind === "router") ly = n.y - r - 14 * k;
  ctx.fillText(label, lx, ly);
}

// ---------- touch, mouse, wheel ----------
const tip = document.getElementById("tip");
const pointers = new Map();
let drag = null, pinch = null, moved = false, lastTap = 0;

let lastPointer = "mouse";
function hitTest(sx, sy) {
  const [x, y] = toWorld(sx, sy);
  const finger = lastPointer !== "mouse";
  const reach = (finger ? 34 : 20) / view.s, zr = Math.pow(view.s, -0.55);
  let best = null, bd = reach;
  for (const n of nodes.values()) {
    if (n.kind === "net-hidden" || n.kind === "org") continue;
    // Devices, the router and this PC get a head start, so a tap near one picks it, not an internet dot beside it.
    const big = n.kind === "lan" || n.kind === "pc" || n.kind === "router";
    const d = Math.hypot(n.x - x, n.y - y) - n.r * zr - (big ? (finger ? 14 : 8) / view.s : 0);
    if (d < bd) { bd = d; best = n.key; }
  }
  if (best) return best;
  const dx = x - CX, dy = y - CY, r = Math.hypot(dx, dy);
  if (r > R2 - 20 && r < R2 + 60) {
    const a = Math.atan2(dy, dx);
    for (const g of orgs.values()) for (const aa of [a, a + Math.PI * 2, a - Math.PI * 2]) if (aa >= g.start && aa <= g.start + g.span) return g.key;
  }
  return null;
}

sky.addEventListener("pointerdown", (e) => {
  lastPointer = e.pointerType || "mouse";
  sky.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  moved = false;
  if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: view.s, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, vx: view.x, vy: view.y };
    drag = null;
  }
});
sky.addEventListener("pointermove", (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const s2 = Math.min(8, Math.max(0.6, pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d));
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    view.x = mx - (pinch.mx - pinch.vx) * (s2 / pinch.s);
    view.y = my - (pinch.my - pinch.vy) * (s2 / pinch.s);
    view.s = s2; view.goal = null; moved = true; layoutSoon();
    return;
  }
  if (drag && pointers.size === 1) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 5) moved = true;
    if (moved) { view.x = drag.vx + dx; view.y = drag.vy + dy; view.goal = null; sky.style.cursor = "grabbing"; }
    return;
  }
  if (e.pointerType === "mouse") {
    hover = hitTest(e.clientX, e.clientY);
    sky.style.cursor = hover ? "pointer" : "grab";
    if (!hover) { tip.hidden = true; return; }
    tip.innerHTML = tipHtml(hover); tip.hidden = false;
    tip.style.left = `${Math.min(e.clientX + 14, W - 290)}px`; tip.style.top = `${Math.min(e.clientY + 14, H - 80)}px`;
  }
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 1) { const p = [...pointers.values()][0]; drag = { x: p.x, y: p.y, vx: view.x, vy: view.y }; }
  if (pointers.size === 0) {
    drag = null; sky.style.cursor = hover ? "pointer" : "grab";
    if (!moved && e.type === "pointerup") {
      if (S.onTap && S.onTap(e)) return;   // house.js: placing a device on the plan
      const nowT = performance.now();
      if (nowT - lastTap < 300) { zoomAt(e.clientX, e.clientY, 2); lastTap = 0; return; }   // double tap
      lastTap = nowT;
      const k = hitTest(e.clientX, e.clientY);
      if (k) openDrawer(k); else closeDrawer();
    }
    if (moved) layoutSoon();
  }
}
sky.addEventListener("pointerup", endPointer);
sky.addEventListener("pointercancel", endPointer);
sky.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") { hover = null; tip.hidden = true; } });
sky.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });

document.getElementById("zoomIn").addEventListener("click", () => zoomAt(W / 2, NARROW ? CY : H / 2, 1.6));
document.getElementById("zoomOut").addEventListener("click", () => zoomAt(W / 2, NARROW ? CY : H / 2, 1 / 1.6));
document.getElementById("zoomFit").addEventListener("click", fit);

function tipHtml(key) {
  if (key.startsWith("net:")) {
    const h = S.hosts.get(key.slice(4));
    return h ? `<b>${esc(hostName(h))}</b><span>${esc(h.org || "Owner unknown")}, ${fmtBytes(h.in)} down, ${fmtBytes(h.out)} up</span>` : `<b>${esc(key.slice(4))}</b>`;
  }
  if (key.startsWith("org:")) {
    const g = orgs.get(key.slice(4));
    return `<b>${esc(key.slice(4))}</b><span>${g.all.length} address${g.all.length === 1 ? "" : "es"}, ${fmtBytes(g.bytes)}</span>`;
  }
  if (key.startsWith("lan:")) {
    const ip = key.slice(4), d = S.devices.get(ip);
    return `<b>${esc(nodeLabel(key))}</b><span>${esc(ip)}${d && d.vendor ? `, ${esc(d.vendor)}` : ""}${isNew(d) ? ", new" : ""}</span>`;
  }
  if (key === "router") return `<b>Router</b><span>${esc(S.gateway || "")} answers in ${esc(lastMs("routerMs"))}</span>`;
  if (key === "pc") return `<b>${esc(myName())}</b><span>Every spark starts or ends here</span>`;
  if (key === "cast") return `<b>Everyone</b><span>Messages sent to the whole network, like "is there a printer here?"</span>`;
  return esc(key);
}
function lastMs(k) {
  const v = S.vitals && S.vitals[k] && S.vitals[k].filter((x) => x != null).slice(-1)[0];
  return v == null ? "no reply" : `${v < 1 ? "under 1" : Math.round(v)} ms`;
}

// ---------- Watch a service: spotlight one owner's packets moving across the map ----------
const watchHud = document.getElementById("watchHud");
function startWatch(org) {
  if (!org) return;
  S.watch = { org };
  watchStat.bytes = 0; watchStat.sparks = 0; watchStat.lastTotal = watchServiceTotals().total; watchStat.rate = 0;
  closeDrawer();
  const on = nodes.get(`org:${org}`);
  if (on) flyTo((on.tx + CX) / 2, (on.ty + CY) / 2, NARROW ? 1.25 : 1.5);
  watchHud.hidden = false; renderWatchHud();
  toast(`Watching ${esc(org)} packets. Everything else is dimmed.`);
}
function stopWatch() { S.watch = null; watchHud.hidden = true; if (!view.goal) fit(); }
function watchServiceTotals() {
  const now = Date.now() / 1000; let inB = 0, outB = 0, live = 0; const progs = {}; let topHost = null;
  if (S.watch) for (const h of S.hosts.values()) if (h.org === S.watch.org) {
    inB += h.in; outB += h.out;
    if (now - h.last < 120) live++;
    if (!topHost || h.in + h.out > topHost.in + topHost.out) topHost = h;
    for (const [p, v] of Object.entries(h.progs)) progs[p] = (progs[p] || 0) + v;
  }
  const topProg = Object.entries(progs).sort((a, b) => b[1] - a[1])[0];
  return { inB, outB, total: inB + outB, live, topHost, topProg: topProg ? topProg[0] : null };
}
function renderWatchHud() {
  if (!S.watch) return;
  const t = watchServiceTotals();
  const rateMb = (watchStat.rate * 8 / 1e6);
  watchHud.innerHTML = `
    <div class="whHead"><span class="whDot"></span><b>${esc(S.watch.org)}</b><button type="button" class="whClose" aria-label="Stop watching">Stop</button></div>
    <div class="whRate"><span class="whNum">${rateMb < 0.1 ? "0" : rateMb.toFixed(rateMb < 10 ? 1 : 0)}</span><span class="whUnit">Mb/s now</span></div>
    <div class="whRow"><span>Downloaded</span><b>${fmtBytes(t.inB)}</b></div>
    <div class="whRow"><span>Uploaded</span><b>${fmtBytes(t.outB)}</b></div>
    ${t.topProg ? `<div class="whRow"><span>Program</span><b>${esc(t.topProg)}</b></div>` : ""}
    <div class="whRow"><span>Live servers</span><b>${t.live}</b></div>
    <p class="whNote">These are this PC's own packets to ${esc(S.watch.org)}. Other devices show up as website requests, not packets, because Huginn only reads this computer's traffic.</p>`;
}
watchHud.addEventListener("click", (e) => { if (e.target.closest(".whClose")) stopWatch(); });
setInterval(() => {
  if (!S.watch) return;
  const total = watchServiceTotals().total;
  watchStat.rate = Math.max(0, total - watchStat.lastTotal);   // bytes in the last second
  watchStat.lastTotal = total;
  renderWatchHud();
}, 1000);
addEventListener("keydown", (e) => { if (e.key === "Escape" && S.watch) { e.preventDefault(); stopWatch(); } });

// ---------- detail sheet ----------
const drawer = document.getElementById("drawer");
const drawerBody = document.getElementById("drawerBody");
let editing = null;     // mac being renamed, so live refreshes don't wipe the form
document.getElementById("close").addEventListener("click", closeDrawer);
let focusBack = null;
function closeDrawer() {
  const was = !drawer.hidden;
  S.selected = null; editing = null; drawer.hidden = true;
  if (was && focusBack && document.contains(focusBack)) focusBack.focus({ preventScroll: true });
  focusBack = null;
}
function openDrawer(key) {
  if (drawer.hidden && document.activeElement && document.activeElement !== document.body) focusBack = document.activeElement;
  S.selected = key; editing = null; drawer.hidden = false; renderDrawer(); drawer.scrollTop = 0;
  const h = drawerBody.querySelector("h2"); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
}

function bars(entries, fmt = fmtBytes) {
  const max = Math.max(1, ...entries.map((e) => e[1]));
  return `<ul class="bars">${entries.map(([k, v, key]) =>
    `<li class="${key ? "click" : ""}" ${key ? `data-key="${esc(key)}"` : ""}><i style="width:${(v / max) * 100}%"></i><span>${esc(k)}</span><span>${fmt(v)}</span></li>`).join("")}</ul>`;
}
drawerBody.addEventListener("click", (e) => {
  const w = e.target.closest("[data-watch]"); if (w) return startWatch(w.dataset.watch);
  const li = e.target.closest("[data-key]:not([data-act])"); if (li) return openDrawer(li.dataset.key);
  const act = e.target.closest("[data-act]"); if (!act) return;
  const a = act.dataset.act;
  if (a === "rename") { editing = act.dataset.mac; renderDrawer(); const inp = drawerBody.querySelector("#nameInput"); if (inp) { inp.focus(); inp.select(); } }
  if (a === "cancel") { editing = null; renderDrawer(); }
  if (a === "find") { const n = nodes.get(S.selected); if (n) flyTo(n.tx, n.ty, 2.6); if (NARROW) drawer.hidden = true; }
  if (a === "replay") { startReplay(Number(act.dataset.t)); return; }
  if (a === "pick") { drawerBody.querySelectorAll(".iconPick button").forEach((b) => b.setAttribute("aria-pressed", String(b === act))); }
});
drawerBody.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target, mac = form.dataset.mac;
  const label = form.querySelector("#nameInput").value;
  const picked = form.querySelector('.iconPick button[aria-pressed="true"]');
  const btn = form.querySelector('button[type="submit"]'), msg = form.querySelector(".formMsg");
  btn.disabled = true; btn.textContent = "Saving";
  try {
    const r = await fetch("api/devices/label", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mac, label, icon: picked ? picked.dataset.icon : null }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Not saved.");
    if (j.device) S.devices.set(j.device.ip, j.device);
    editing = null; renderDrawer(); toast(`Saved: ${esc(deviceName(j.device) || "device")}`);
  } catch (err) {
    msg.textContent = err.message; btn.disabled = false; btn.textContent = "Save";
  }
});

function lookupsHtml(ip) {
  const L = S.lookups.get(ip);
  if (!L) return "";
  const rows = L.top.slice(0, 20).map(([dom, n, blocked, last]) =>
    `<li><span>${blocked ? '<b class="blk">blocked</b> ' : ""}${esc(dom)}</span><span>${n > 1 ? n + "x, " : ""}${ago(last)}</span></li>`).join("");
  return `<h3>Websites it asked for</h3>
    <dl><dt>Asked</dt><dd>${L.total.toLocaleString()}</dd><dt>Blocked</dt><dd>${L.blocked.toLocaleString()}${L.total ? ` (${Math.round(100 * L.blocked / L.total)}%)` : ""}</dd><dt>Last</dt><dd>${ago(L.last)}</dd></dl>
    <ul class="bars plain">${rows}</ul>`;
}

// ---------- "In plain words": a local, offline teacher that reads the facts Huginn already has
// and explains, in simple language, what a node is, what it is doing, and why. No internet, no cloud AI:
// it reasons from the device type, its lookups, its chatter, and any scan results on the page.
function aAn(w) { return /^[aeiou]/i.test(w) ? "an " : "a "; }
function joinNice(a) { a = a.filter(Boolean); return a.length <= 1 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]; }
function openServiceNames(ip) {
  const r = S.enumer.results[ip]; let ports = [];
  if (r && r.services && r.services.length) ports = r.services.map((s) => Number(s.port));
  else { const d = S.devices.get(ip); if (d && d.ports) ports = d.ports.map(Number); }
  const hide = new Set([1900, 5353, 5355, 5357]);   // pure discovery, not a service it "offers"
  return [...new Set(ports.filter((p) => !hide.has(p)).map((p) => PORT_NAMES[p] || `port ${p}`))];
}
function learnCard(title, body) { return `<p class="exLearn"><b>${esc(title)}</b> ${body}</p>`; }

function explainLan(ip) {
  const d = S.devices.get(ip), st = S.lan.get(ip), L = S.lookups.get(ip);
  const name = deviceName(d) || ip;
  const kindWord = d && d.icon && d.icon !== "unknown" ? (ICON_WORDS[d.icon] || "device").toLowerCase() : "device";
  const sameAsVendor = d && realName(d.name) && d.vendor && realName(d.name) === d.vendor;
  const vendor = d && d.vendor && !sameAsVendor && realName(d.name) ? ` made by ${esc(d.vendor)}` : "";
  const link = d && d.link ? (d.link === "cable" ? ", plugged in with a cable" : ", on Wi-Fi") : "";
  const guest = isGuest(d) ? ", kept on your guest network away from your main devices" : "";
  const what = `This is ${aAn(kindWord)}<b>${kindWord}</b>${name && name !== ip ? ` you'd call <b>${esc(name)}</b>` : ""}${vendor}${link}${guest}.`;

  const doing = [], svc = openServiceNames(ip), offline = d && d.status && /off|gone|away/i.test(d.status);
  if (offline) doing.push("Right now it looks asleep or unplugged, so there is nothing to hear from it.");
  if (L && L.total) {
    const pct = L.total ? Math.round(100 * L.blocked / L.total) : 0;
    doing.push(`It has asked for <b>${L.total.toLocaleString()}</b> web address${L.total === 1 ? "" : "es"}${pct ? `, and the Pi-hole swatted <b>${pct}%</b> of them as ads or trackers` : ""}.`);
  }
  if (st && st.chatter) doing.push("It keeps announcing itself to the whole house so phones and TVs can find it.");
  if (svc.length) doing.push(`It leaves ${svc.length === 1 ? "a door" : "doors"} open for other devices to connect to: <b>${esc(joinNice(svc))}</b>.`);
  if (!doing.length) doing.push(offline ? "" : "It is connected but quiet at the moment, not sending much our way.");

  const why = [];
  if (isNew(d)) why.push("The <b>New</b> tag just means this is the first time Huginn has seen it on the network.");
  if (L && L.total && L.blocked / Math.max(1, L.total) > 0.25) why.push("A high block rate is normal: apps and smart gadgets phone home to ad and tracking servers constantly in the background, and the Pi-hole quietly refuses those.");
  if (svc.length) why.push("A device opens a door (a port) when it runs a little service of its own: a camera's video, a printer's web page, a media library, a settings screen.");
  if (isGuest(d)) why.push("It sits on the guest network on purpose, so even if it were ever taken over it cannot reach your trusted machines.");

  let learn = learnCard("How devices find websites:", "every time a gadget wants a site it first asks a name server, “what is the address for this name?” — that question is a <b>DNS lookup</b>. Your Pi-hole answers them, which is also how it can decline the ones on its blocklist.");
  if (!(L && L.total) && st && st.chatter) learn = learnCard("How gadgets find each other:", "with no central directory at home, devices shout a short message to <b>everyone</b> on the network (mDNS) — “I'm a printer, here's my address.” That is the chatter you see, and it is how AirPlay and casting work.");
  else if (!(L && L.total) && svc.length) learn = learnCard("Ports are doors:", "a device has 65,535 numbered <b>ports</b>. Most stay shut; a service opens one and listens. Knowing which ports are open tells you what a device actually does, which is exactly what Enumerate reads.");
  return explainCard(what, doing, why, learn);
}

function explainRouter() {
  const v = S.vitals || {}, rs = (v.routerMs || []).filter((x) => x != null);
  const avg = rs.length ? Math.round(rs.reduce((a, b) => a + b, 0) / rs.length) : null;
  const what = "This is your <b>router</b> — the single box every device in the house goes through to reach the internet.";
  const doing = [avg != null ? `It answers this PC in about <b>${avg} ms</b>, and everything you see leaving or arriving passes through it.` : "It carries all the traffic between your home and the internet."];
  const why = ["It hands each device a private home address, and it performs <b>NAT</b>: it rewrites those private addresses to your one public address so many devices can share a single internet line.",
    "Because everything funnels through it, the router is both the most useful place to watch traffic and the most important one to keep patched."];
  const learn = learnCard("Latency, in one line:", "the millisecond number is a packet's <b>round trip</b>. A low, steady time to the router means your link to it is healthy; the internet number adds the whole journey out to a far server and back.");
  return explainCard(what, doing, why, learn);
}

function explainPc() {
  const what = `This is the computer <b>${esc(myName())}</b> that Huginn itself runs on.`;
  const doing = ["It is the one device whose real traffic Huginn can read in detail — which programs are talking, and to whom."];
  const why = ["On a modern switched network a device normally only receives its own traffic, so Huginn sees this PC fully, everyone else by their announcements and their DNS lookups."];
  const learn = learnCard("Why you see this PC best:", "an old hub copied every packet to every port; a <b>switch</b> sends each packet only to the device it's for. Good for speed and privacy, which is why the view of other devices is deliberately limited.");
  return explainCard(what, doing, why, learn);
}

function explainNet(ip) {
  const h = S.hosts.get(ip); if (!h) return "";
  const what = `This is a <b>server out on the internet</b>${h.org ? `, owned by <b>${esc(h.org)}</b>` : ""}, that something in your house connected to.`;
  const doing = [`Your side pulled <b>${fmtBytes(h.in)}</b> down and sent <b>${fmtBytes(h.out)}</b> up to it.`];
  const why = ["Your devices reach out to servers like this one to load pages, stream video, sync, or check for updates. The traffic started from your side — this is a reply, not someone reaching in."];
  const learn = learnCard("Why one name has many addresses:", "popular services run copies of themselves in data centers near you — a <b>content delivery network</b> — so a single name can resolve to whichever server is closest and fastest.");
  return explainCard(what, doing, why, learn);
}

function explainOrg(o) {
  const g = orgs.get(o); if (!g) return "";
  const what = `This is a group of internet servers all owned by <b>${esc(o)}</b> that your devices have been talking to.`;
  const doing = [`${g.all.length} address${g.all.length === 1 ? "" : "es"} in all, ${fmtBytes(g.bytes)} of traffic together.`];
  const why = ["Huginn clusters internet endpoints by their owner so a wall of raw addresses becomes a handful of names you recognise."];
  const learn = learnCard("Who owns an address:", "every internet address belongs to an organisation in public registries (the <b>WHOIS</b>/ASN records). Grouping by owner is how a hundred cryptic numbers turn into “Netflix” or “Google.”");
  return explainCard(what, doing, why, learn);
}

function explainCard(what, doing, why, learn) {
  const bodyDoing = doing.filter(Boolean);
  return `<section class="explain" aria-label="In plain words">
    <h3 class="exH">${RAVEN_SVG}In plain words</h3>
    <p class="exWhat">${what}</p>
    ${bodyDoing.length ? `<p class="exLbl">What it's doing</p>${bodyDoing.map((d) => `<p class="exP">${d}</p>`).join("")}` : ""}
    ${why.length ? `<p class="exLbl">Why</p>${why.map((w) => `<p class="exP">${w}</p>`).join("")}` : ""}
    ${learn || ""}
  </section>`;
}
function explainHtml(key) {
  try {
    if (key.startsWith("lan:")) return explainLan(key.slice(4));
    if (key.startsWith("net:")) return explainNet(key.slice(4));
    if (key.startsWith("org:")) return explainOrg(key.slice(4));
    if (key === "router") return explainRouter();
    if (key === "pc") return explainPc();
  } catch (e) { return ""; }
  return "";
}
const RAVEN_SVG = `<svg class="exRaven" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M3 12c2-1 4-1 6 0 M9 12c1-4 5-6 9-5 -2 1-3 2-3 4 2 0 4 1 5 3 -3 1-6 1-8 0 -1 2-3 3-5 3 1-2 0-4-3-5z"/></svg>`;

function renameForm(d) {
  const picks = Object.keys(ICON_PATHS).map((ic) =>
    `<button type="button" data-act="pick" data-icon="${ic}" aria-pressed="${ic === d.icon}" title="${ICON_WORDS[ic]}">${iconSvg(ic, 22)}<span>${ICON_WORDS[ic]}</span></button>`).join("");
  return `<form class="rename" data-mac="${esc(d.mac)}">
    <label for="nameInput">Name</label>
    <input id="nameInput" maxlength="60" autocomplete="off" value="${esc(d.label || realName(d.name) || "")}" placeholder="${esc(d.vendor || "Living room TV")}">
    <p class="lbl">Icon</p>
    <div class="iconPick">${picks}</div>
    <div class="row"><button type="submit" class="primary">Save</button><button type="button" data-act="cancel">Cancel</button></div>
    <p class="formMsg" role="alert"></p>
  </form>`;
}

function renderDrawer() {
  const key = S.selected; if (!key) return;
  if (editing && drawerBody.querySelector("form.rename")) return;   // don't wipe a half-typed name
  let html = "";
  if (key.startsWith("lan:")) {
    const ip = key.slice(4), d = S.devices.get(ip), st = S.lan.get(ip);
    if (d && editing === d.mac) {
      html = `<h2 class="withIcon">${iconSvg(d.icon, 26)}Rename</h2><p class="sub">${esc(ip)}${d.vendor ? `, ${esc(d.vendor)}` : ""}</p>${renameForm(d)}`;
    } else {
      const net = d && d.subnet ? (S.subnets.find((s) => s.cidr === d.subnet || s.name === d.subnet) || {}).name || d.subnet : null;
      html = `<h2 class="withIcon">${iconSvg(d ? d.icon : "unknown", 26)}${esc(nodeLabel(key))}</h2>
        <p class="sub">${esc([d && ICON_WORDS[d.icon], d && d.vendor].filter(Boolean).join(", ") || "Not identified yet")}${isNew(d) ? ' <b class="newTag">New</b>' : ""}</p>
        <div class="actions">
          ${d && d.mac ? `<button type="button" class="primary" data-act="rename" data-mac="${esc(d.mac)}">${isNew(d) || !d.label ? "Name it" : "Rename"}</button>` : ""}
          <button type="button" data-act="find">Show on map</button>
          <button type="button" data-act="ride" data-key="${esc(key)}">Ride its packets</button>
          ${S.view === "house" ? `<button type="button" data-act="place" data-key="${esc(key)}">${S.house.places[(d && d.mac) || `ip:${ip}`] ? "Move in the house" : "Place in the house"}</button>` : ""}
        </div>
        ${explainHtml(key)}
        ${zoneSectionHtml(d)}
        ${unusualDeviceHtml(d, ip)}
        ${hostCheckHtml(key)}
        ${enumHtml(ip)}
        ${deepLookHtml(ip)}
        ${linkHtml(d)}
        <dl>
          ${d && d.status ? `<dt>Status</dt><dd>${esc(d.status)}</dd>` : ""}
          ${d ? `<dt>First seen</dt><dd>${esc(day(d.firstSeen))}</dd><dt>Last seen</dt><dd>${esc(ago(d.lastSeen))}</dd>` : ""}
        </dl>
        <details class="nerd"><summary>Technical details</summary><dl>
          <dt>Address</dt><dd class="addr">${esc(ip)}</dd>
          ${d && d.mac ? `<dt>Device ID</dt><dd class="addr">${esc(d.mac)}${d.privateMac ? " (private, changes)" : ""}</dd>` : ""}
          ${d && d.hostname ? `<dt>Its own name</dt><dd>${esc(d.hostname)}</dd>` : ""}
          ${net ? `<dt>Network</dt><dd>${esc(net)}</dd>` : ""}
          ${d && d.ports && d.ports.length ? `<dt>Open doors</dt><dd>${esc(d.ports.join(", "))}</dd>` : ""}
        </dl></details>
        ${lookupsHtml(ip)}
        <details class="nerd"><summary>What ${esc(myName())} heard from it</summary>
        ${st && (st.in || st.chatter) ? `<dl><dt>With this PC</dt><dd>${fmtBytes(st.in + st.out)}</dd><dt>Announcements</dt><dd>${fmtBytes(st.chatter)}</dd><dt>Last heard</dt><dd>${ago(st.last)}</dd></dl>
          <ul class="bars">${Object.entries(st.ports).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `<li><span>${esc(k)}</span><span>${fmtBytes(v)}</span></li>`).join("")}</ul>`
          : `<p class="note">Nothing directly. This PC only hears what a device sends to it or to everyone; its own internet traffic goes straight through the router. The ad blocker list above shows which websites it asked for.</p>`}</details>`;
    }
  } else if (key.startsWith("net:")) {
    const h = S.hosts.get(key.slice(4));
    if (!h) html = `<h2>${esc(key.slice(4))}</h2><p class="sub">Gone quiet. It drops off the map after 15 quiet minutes.</p>`;
    else {
      const progs = Object.entries(h.progs).sort((a, b) => b[1] - a[1]);
      const ports = Object.entries(h.ports).sort((a, b) => b[1] - a[1]).map(([p, v]) => { const [n, pr] = p.split("/"); return [service(Number(n), pr), v]; });
      html = `<h2>${esc(hostName(h))}</h2><p class="sub">${esc(h.org || "Owner unknown")}</p>
        <div class="actions">${h.org ? `<button type="button" class="primary" data-watch="${esc(h.org)}">Watch ${esc(h.org)} packets</button>` : ""}<button type="button" data-act="find">Show on map</button></div>
        ${explainHtml(key)}
        <dl><dt>Address</dt><dd class="addr">${esc(h.ip)}</dd><dt>Down</dt><dd>${fmtBytes(h.in)}</dd><dt>Up</dt><dd>${fmtBytes(h.out)}</dd>
          <dt>Packets</dt><dd>${h.pkts.toLocaleString()}</dd><dt>First seen</dt><dd>${clock(h.first)} (${ago(h.first)})</dd><dt>Last seen</dt><dd>${ago(h.last)}</dd></dl>
        <h3>Which programs talked to it</h3>${progs.length ? bars(progs) : `<p class="note">Not matched to a program yet.</p>`}
        <h3>How</h3>${bars(ports)}`;
    }
  } else if (key.startsWith("org:")) {
    const o = key.slice(4), g = orgs.get(o);
    if (!g) html = `<h2>${esc(o)}</h2><p class="sub">Gone quiet.</p>`;
    else {
      const progs = {};
      for (const h of g.all) for (const [p, v] of Object.entries(h.progs)) progs[p] = (progs[p] || 0) + v;
      html = `<h2>${esc(o)}</h2><p class="sub">${g.all.length} address${g.all.length === 1 ? "" : "es"}, ${fmtBytes(g.bytes)} in all</p>
        <div class="actions"><button type="button" class="primary" data-watch="${esc(o)}">Watch its packets</button><button type="button" data-act="find">Show on map</button></div>
        ${explainHtml(key)}
        <h3>Busiest addresses</h3>${bars(g.all.slice(0, 14).map((h) => [hostName(h), h.in + h.out, `net:${h.ip}`]))}
        <h3>Programs using ${esc(o)}</h3>${Object.keys(progs).length ? bars(Object.entries(progs).sort((a, b) => b[1] - a[1])) : `<p class="note">None matched yet.</p>`}`;
    }
  } else if (key === "pc") {
    const progs = {}, now = Date.now() / 1000;
    for (const h of S.hosts.values()) if (now - h.last < 300) for (const [p, v] of Object.entries(h.progs)) progs[p] = (progs[p] || 0) + v;
    const recent = [...S.hosts.values()].filter((h) => now - h.last < 300).sort((a, b) => (b.in + b.out) - (a.in + a.out)).slice(0, 12);
    html = `<h2 class="withIcon">${iconSvg("computer", 26)}This PC</h2><p class="sub">${esc([...S.localIps].filter((i) => /^192\.168\./.test(i)).join(", "))}</p>
      ${explainHtml("pc")}
      ${hostCheckHtml("pc")}
      <h3>Programs on the network, last 5 minutes</h3>${Object.keys(progs).length ? bars(Object.entries(progs).sort((a, b) => b[1] - a[1]).slice(0, 12)) : `<p class="note">Matching programs to traffic.</p>`}
      <h3>Who it's talking to</h3>${bars(recent.map((h) => [hostName(h), h.in + h.out, `net:${h.ip}`]))}
      ${[...S.localIps].map(lookupsHtml).join("")}`;
  } else if (key === "router") {
    const v = S.vitals || {}, rs = (v.routerMs || []).filter((x) => x != null), ns = (v.netMs || []).filter((x) => x != null);
    const avg = (a) => a.length ? `${Math.round(a.reduce((x, y) => x + y, 0) / a.length)} ms` : "none";
    html = `<h2 class="withIcon">${iconSvg("router", 26)}Router</h2><p class="sub">${esc(S.gateway || "")}, the door between the house and the internet</p>
      <dl><dt>Answers this PC</dt><dd>${avg(rs)} on average, worst ${rs.length ? Math.round(Math.max(...rs)) : "-"} ms</dd>
        <dt>Internet replies</dt><dd>${avg(ns)} on average, usual ${v.netBaseline != null ? Math.round(v.netBaseline) + " ms" : "-"}</dd>
        <dt>Fastest down seen</dt><dd>${mbps(v.peakDown || 0)} Mb/s</dd><dt>Fastest up seen</dt><dd>${mbps(v.peakUp || 0)} Mb/s</dd></dl>
      <p class="note">${esc(v.line ? v.line.text : "")}</p>
      ${explainHtml("router")}
      ${S.gateway ? enumHtml(S.gateway) : ""}
      ${S.gateway ? deepLookHtml(S.gateway) : ""}`;
  } else if (key === "cast") {
    const talkers = [...S.lan.values()].filter((l) => l.chatter > 0).sort((a, b) => b.chatter - a.chatter);
    html = `<h2>Everyone</h2><p class="sub">Messages a device sends to the whole network at once. It's how phones find TVs and printers.</p>
      ${talkers.length ? bars(talkers.map((l) => [deviceName(S.devices.get(l.ip)) || l.ip, l.chatter, `lan:${l.ip}`])) : `<p class="note">Nothing heard yet.</p>`}`;
  } else if (key.startsWith("at:")) {
    const t = Number(key.slice(3)), row = S.series.find((r) => r.t === t);
    html = `<h2>${clock(t)}</h2><p class="sub">${row ? `${mbps(row.in)} Mb/s down, ${mbps(row.out)} Mb/s up, ${row.pkts} packets that second` : "Not in the last hour."}</p>
      <div class="actions"><button type="button" class="primary" data-act="replay" data-t="${t - 20}">Replay from here</button></div>
      <h3>Busiest that second</h3>${row && row.top.length ? bars(row.top) : `<p class="note">Quiet.</p>`}`;
  } else if (key === "list:devices") {
    html = devicesListHtml();
  } else if (key === "replay:pick") {
    if (drawerBody.querySelector("form.rewind")) return;   // don't reset a time being picked
    html = rewindHtml();
  } else if (key === "zones:home") {
    html = zonesHomeHtml();
  } else if (key === "more:menu") {
    html = `<h2>More</h2>
      <div class="moreList">
        <button type="button" data-more="live">${S.paused ? "Resume the live map" : "Pause the map"}</button>
        <button type="button" data-more="rewind">${S.replay ? "Back to live" : "Rewind"}</button>
        <button type="button" data-more="log">Live activity</button>
        <button type="button" data-more="simple">${S.simple ? "Simple view is on (tap for full view)" : "Simple view (bigger, calmer, fewer dots)"}</button>
        <button type="button" data-more="scan">Scan for devices now</button>
        ${/Android/.test(navigator.userAgent) && !navigator.userAgent.includes("HuginnApp/") ? `<a class="moreLink" href="download/huginn.apk" download>Get the Android app</a>` : ""}
      </div>`;
  } else if (key === "unusual:home") {
    html = unusualHomeHtml();
  }
  drawerBody.innerHTML = html;
}
setInterval(() => { if (S.selected && !editing) renderDrawer(); }, 2000);

// ---------- devices list ----------
function devicesListHtml() {
  const all = [...S.devices.values()].filter((d) => d.ip && d.ip !== S.gateway);
  const lastAsk = (d) => (S.lookups.get(d.ip) || {}).last || 0;
  all.sort((a, b) => (isNew(b) - isNew(a)) || (lastAsk(b) - lastAsk(a)) || String(deviceName(a)).localeCompare(String(deviceName(b))));
  const fresh = all.filter(isNew).length;
  const row = (d) => {
    const L = S.lookups.get(d.ip);
    const bits = [d.ip, L ? `asked for ${L.total.toLocaleString()} sites` : null, d.status === "offline" ? "offline" : null].filter(Boolean).join(", ");
    return `<li class="dev" data-key="lan:${esc(d.ip)}">${iconSvg(d.ip === S.piholeIp ? "server" : d.icon, 22)}<span class="dn"><b>${esc(nodeLabel(`lan:${d.ip}`))}</b><small>${esc(bits)}</small></span>${isNew(d) ? '<b class="newTag">New</b>' : ""}</li>`;
  };
  return `<h2>Devices</h2><p class="sub">${all.length} known${fresh ? `, ${fresh} new` : ""}. Tap one for details or to name it.</p>
    <div class="actions"><button type="button" class="primary" id="scanBtn2">Scan now</button></div>
    <ul class="devs">${all.map(row).join("")}</ul>`;
}
drawerBody.addEventListener("click", (e) => { if (e.target.id === "scanBtn2") scanNow(); });

// ---------- new devices arriving ----------
const toasts = document.getElementById("toasts");
function toast(html, actions = "") {
  const el = document.createElement("div");
  el.className = "toast"; el.innerHTML = `<button type="button" class="tClose" data-dismiss aria-label="Close">×</button><p>${html}</p>${actions}`;
  toasts.prepend(el);
  if (!actions) {   // a note with a button (Undo, Look) waits for you; a plain note stays 20 seconds
    setTimeout(() => el.classList.add("out"), 20000);
    setTimeout(() => el.remove(), 20600);
  }
  while (toasts.children.length > 4) toasts.lastElementChild.remove();
  return el;
}
toasts.addEventListener("click", (e) => {
  const x = e.target.closest("[data-dismiss], [data-open], [data-zundo], [data-room-undo]");
  if (x) setTimeout(() => x.closest(".toast") && x.closest(".toast").remove(), 0);
  const b = e.target.closest("[data-open]"); if (!b) return;
  openDrawer(b.dataset.open);
  const d = S.devices.get(b.dataset.open.slice(4));
  if (d && b.dataset.name) { editing = d.mac; drawerBody.innerHTML = ""; renderDrawer(); }
  b.closest(".toast").remove();
});
function arrivals(list) {
  for (const d of list) {
    const key = `lan:${d.ip}`;
    setTimeout(() => {
      const n = nodes.get(key);
      if (n) bursts.push({ node: n, born: performance.now(), color: COLORS.ember, dur: 1600, size: 46 });
    }, 1300);
    toast(`New device on the network: <b>${esc(deviceName(d))}</b> at ${esc(d.ip)}`,
      `<div class="row"><button type="button" class="primary" data-open="${esc(key)}" data-name="1">Name it</button><button type="button" data-open="${esc(key)}">Look</button></div>`);
  }
}
function updateNewCount() {
  const n = [...S.devices.values()].filter(isNew).length;
  const b = document.getElementById("devicesBtn");
  b.querySelector(".count").textContent = n ? String(n) : "";
  b.classList.toggle("hasNew", n > 0);
}

async function scanNow() {
  const b = document.getElementById("scanBtn");
  b.disabled = true; b.textContent = "Scanning";
  try {
    const r = await fetch("api/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const j = await r.json();
    toast(esc(j.note || "Scanning"));
    if (!j.running) { b.disabled = false; b.textContent = "Scan now"; }
  } catch { toast("Huginn couldn't reach Odin's Watch."); b.disabled = false; b.textContent = "Scan now"; }
}
function setScan(sc) {
  const b = document.getElementById("scanBtn");
  b.disabled = !!(sc && sc.running); b.textContent = sc && sc.running ? "Scanning" : "Scan now";
}

// ---------- flight log ----------
const logEl = document.getElementById("log");
let logBudget = 0;
function shortName(n) { n = String(n); return n.length > 30 ? "…" + n.slice(-29) : n; }
function logSparks(list) {
  if (S.paused) return;
  logBudget = Math.min(logBudget + 1.4, 4);
  const pool = list.filter((s) => s.k !== "chatter" || Math.random() < 0.3);
  const pick = [];
  while (logBudget >= 1 && pool.length) { pick.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]); logBudget -= 1; }
  for (const s of pick.sort((a, b) => a.t - b.t)) {
    const li = document.createElement("li");
    li.className = `k-${s.k} fresh`;
    if (s.dom) {
      li.innerHTML = `<span class="t">${clock(s.t, true)}</span><span class="who">${esc(shortName(nodeLabel(s.s)))} <span class="arrow">${KIND_WORD[s.k]}</span> ${esc(shortName(s.dom))}</span>${s.k === "blocked" ? ' <span class="svc">blocked</span>' : ""}`;
    } else {
      const from = s.prog || nodeLabel(s.s), to = nodeLabel(s.d);
      const who = s.k === "in" ? `${esc(shortName(nodeLabel(s.s)))} <span class="arrow">${KIND_WORD.in}</span> ${esc(s.prog || myName())}`
                : `${esc(shortName(from))} <span class="arrow">${KIND_WORD[s.k] || "→"}</span> ${esc(shortName(to))}`;
      li.innerHTML = `<span class="t">${clock(s.t, true)}</span><span class="who">${who}</span> <span class="svc">${esc(service(s.rp, s.p))} ${fmtBytes(s.b)}</span>`;
    }
    logEl.prepend(li);
  }
  while (logEl.children.length > 70) logEl.lastChild.remove();
}

// ---------- vitals ----------
const $ = (id) => document.getElementById(id);
function sparkPath(svg, vals, max) {
  const m = max || Math.max(1, ...vals.filter((x) => x != null));
  let d = "", pen = false;
  vals.forEach((x, i) => {
    if (x == null) { pen = false; return; }
    d += `${pen ? "L" : "M"}${((i / Math.max(1, vals.length - 1)) * 120).toFixed(1)},${(22 - (x / m) * 20).toFixed(1)}`; pen = true;
  });
  svg.innerHTML = `<path d="${d}"/>`;
}
const downHist = [], upHist = [];
function renderVitals(v) {
  S.vitals = v;
  if (v.gateway) S.gateway = v.gateway;
  if (v.piholeIp) S.piholeIp = v.piholeIp;
  $("down").textContent = mbps(v.down); $("up").textContent = mbps(v.up);
  downHist.push(v.down); upHist.push(v.up);
  if (downHist.length > 60) { downHist.shift(); upHist.shift(); }
  sparkPath($("downSpark"), downHist); sparkPath($("upSpark"), upHist);
  const r = (v.routerMs || []).filter((x) => x != null).slice(-1)[0], n = (v.netMs || []).filter((x) => x != null).slice(-1)[0];
  $("router").textContent = r == null ? "-" : r < 1 ? "<1" : Math.round(r);
  $("net").textContent = n == null ? "-" : Math.round(n);
  sparkPath($("routerSpark"), v.routerMs || []); sparkPath($("netSpark"), v.netMs || []);
  const line = $("line"); line.className = `line ${v.line.level}`;
  const plain = { clear: "The internet is working well.", busy: "The internet is busy right now.", slow: "The internet is slow right now.", down: "The internet isn't working right now." }[v.line.level];
  line.innerHTML = /^Measuring/.test(v.line.text) ? "Checking the internet." : `${esc(plain)} <span class="tech">${esc(v.line.text)}</span>`;
  line.title = v.line.text;
  const st = $("status");
  const ph = v.pihole && v.pihole.on ? ", reading Pi-hole" : "";
  st.textContent = v.capture.on ? (S.site ? `Watching ${S.site}` : "Watching your home network") : v.capture.note;
  st.title = v.capture.on ? `${v.capture.note}${ph}` : "";
  renderHomeState();
  st.className = v.capture.on ? "" : "off";
  const pn = $("phNote"); pn.hidden = !(v.pihole && !v.pihole.on && v.pihole.note); pn.textContent = v.pihole ? v.pihole.note : "";
}

// ---------- timeline ----------
const tl = $("tl"), tlc = tl.getContext("2d"), tlTip = $("tlTip");
let tlHoverT = null;
function drawTimeline() {
  const w = tl.clientWidth, h = tl.clientHeight;
  if (!w || !h) return;
  tl.width = w * DPR; tl.height = h * DPR;
  tlc.setTransform(DPR, 0, 0, DPR, 0, 0); tlc.clearRect(0, 0, w, h);
  const end = Math.floor(Date.now() / 1000), start = end - 3600, mid = h * 0.55;
  const rows = S.series.filter((r) => r.t > start);
  const max = Math.max(4096, ...rows.map((r) => Math.max(r.in, r.out)));
  const x = (t) => ((t - start) / 3600) * w;
  tlc.strokeStyle = "rgba(43,59,99,0.8)"; tlc.lineWidth = 1;
  tlc.beginPath(); tlc.moveTo(0, mid + 0.5); tlc.lineTo(w, mid + 0.5); tlc.stroke();
  tlc.fillStyle = COLORS.faint; tlc.font = "11px 'Schibsted Grotesk', system-ui";
  const marks = NARROW ? [60, 30, 0] : [60, 45, 30, 15, 0];
  for (const m of marks) {
    const px = x(end - m * 60);
    tlc.textAlign = m === 0 ? "right" : m === 60 ? "left" : "center";
    tlc.fillText(m === 0 ? "now" : `${m} min ago`, px, h - 1);
  }
  const bw = Math.max(1, w / 3600);
  for (const r of rows) {
    const px = x(r.t), dh = Math.sqrt(r.in / max) * (mid - 4), uh = Math.sqrt(r.out / max) * (h - mid - 14);
    tlc.fillStyle = "rgba(134,214,255,0.75)"; tlc.fillRect(px, mid - dh, bw, dh);
    tlc.fillStyle = "rgba(255,180,92,0.75)"; tlc.fillRect(px, mid + 1, bw, uh);
  }
  if (tlHoverT != null) { tlc.fillStyle = COLORS.bone; tlc.fillRect(x(tlHoverT), 0, 1, h - 14); }
}
setInterval(drawTimeline, 1000);
function tlRowAt(clientX) {
  const rect = tl.getBoundingClientRect(), end = Math.floor(Date.now() / 1000);
  const t = Math.round(end - 3600 + ((clientX - rect.left) / rect.width) * 3600);
  let best = null, bd = 6;
  for (let i = S.series.length - 1; i >= 0; i--) {
    const d = Math.abs(S.series[i].t - t);
    if (d < bd) { bd = d; best = S.series[i]; }
    if (S.series[i].t < t - 10) break;
  }
  return { t, row: best, x: clientX - rect.left };
}
tl.addEventListener("pointermove", (e) => {
  const { t, row, x } = tlRowAt(e.clientX);
  tlHoverT = t; S.highlight = new Set();
  if (row) for (const [label] of row.top) for (const h of S.hosts.values()) if (hostName(h) === label) S.highlight.add(`net:${h.ip}`);
  tlTip.hidden = false;
  tlTip.style.left = `${Math.max(90, Math.min(x, tl.clientWidth - 90))}px`;
  tlTip.innerHTML = row
    ? `<b>${clock(row.t)}</b> ${mbps(row.in)} down, ${mbps(row.out)} up Mb/s${row.top.length ? `<span class="who">${row.top.map(([n, b]) => `${esc(shortName(n))} ${fmtBytes(b)}`).join("<br>")}</span>` : ""}`
    : `<b>${clock(t)}</b> Huginn wasn't watching yet`;
  drawTimeline();
});
tl.addEventListener("pointerleave", () => { tlHoverT = null; tlTip.hidden = true; S.highlight = new Set(); drawTimeline(); });
tl.addEventListener("click", (e) => { const { row } = tlRowAt(e.clientX); if (row) openDrawer(`at:${row.t}`); });

// ---------- buttons ----------
const liveBtn = $("live");
function setPaused(p) { S.paused = p; liveBtn.textContent = p ? "Resume" : "Pause"; liveBtn.setAttribute("aria-pressed", String(p)); }
liveBtn.addEventListener("click", () => setPaused(!S.paused));
$("devicesBtn").addEventListener("click", () => openDrawer("list:devices"));
$("rewindBtn").addEventListener("click", () => (S.replay ? stopReplay() : openDrawer("replay:pick")));
$("scanBtn").addEventListener("click", scanNow);
const logBox = document.querySelector(".log");
$("logBtn").addEventListener("click", () => {
  const open = !logBox.classList.contains("open");
  logBox.classList.toggle("open", open); $("logBtn").setAttribute("aria-pressed", String(open));
});
addEventListener("keydown", (e) => {
  if (e.target.closest("button, input, textarea")) return;
  if (e.code === "Space") { e.preventDefault(); if (S.replay) replayControl("play"); else setPaused(!S.paused); }
  if (e.key === "Escape") closeDrawer();
  if (e.key === "+" || e.key === "=") zoomAt(W / 2, H / 2, 1.4);
  if (e.key === "-") zoomAt(W / 2, H / 2, 1 / 1.4);
  if (e.key === "0") fit();
});

// ---------- the stream ----------
function setDevices(list, subnets) {
  const incoming = list.filter((d) => d.ip);
  if (S.macs) {
    const fresh = incoming.filter((d) => d.mac && !S.macs.has(d.mac));
    if (fresh.length) setTimeout(() => arrivals(fresh), 50);
  }
  S.macs = new Set(incoming.map((d) => d.mac).filter(Boolean));
  S.devices = new Map(incoming.map((d) => [d.ip, d]));
  if (subnets) S.subnets = subnets;
  updateNewCount();
}
function setHosts(hosts, lan, lookups) {
  if (!S.replay) S.hosts = new Map(hosts.map((h) => [h.ip, h]));   // while replaying, the outer ring shows the past
  S.lan = new Map(lan.map((l) => [l.ip, l]));
  if (lookups) S.lookups = new Map(lookups.map((l) => [l.ip, l]));
}
function connect() {
  const es = new EventSource("api/stream");
  es.addEventListener("hello", (e) => {
    const m = JSON.parse(e.data);
    S.localIps = new Set(m.localIps);
    if (m.historyFrom) S.historyFrom = m.historyFrom;
    if (m.house) setHouse(m.house);
    S.guestWifi = m.guestWifi || null;
    S.site = m.site || null;
    if (S.site) document.title = `Huginn: ${S.site}`;
    if (m.zones) setZones(m.zones);
    S.loaded = true;
    if (m.unusual) setUnusual(m.unusual);
    if (m.deeplook) S.deeplook = m.deeplook;
    if (m.enumer) S.enumer = m.enumer;
    S.muninn = m.muninn || {};
    S.macs = null;
    setDevices(m.devices, m.subnets);
    setHosts(m.hosts, m.lan, m.lookups);
    if (m.piholeIp) S.piholeIp = m.piholeIp;
    S.series = m.series;
    renderVitals(m.vitals);
    setScan(m.scan);
    layout(true); drawTimeline();
  });
  es.addEventListener("tick", (e) => {
    const m = JSON.parse(e.data);
    if (!S.replay) { addSparks(m.sparks); logSparks(m.sparks); }
    $("pps").textContent = `${(m.seen * 10).toLocaleString()} packets a second`;
  });
  es.addEventListener("vitals", (e) => {
    const m = JSON.parse(e.data);
    renderVitals(m);
    for (const r of m.sec || []) { S.series.push(r); if (S.series.length > 3600) S.series.shift(); }
  });
  es.addEventListener("hosts", (e) => { const m = JSON.parse(e.data); setHosts(m.hosts, m.lan, m.lookups); });
  es.addEventListener("devices", (e) => { const m = JSON.parse(e.data); setDevices(m.devices, m.subnets); layoutSoon(); });
  es.addEventListener("house", (e) => setHouse(JSON.parse(e.data)));
  es.addEventListener("zones", (e) => setZones(JSON.parse(e.data)));
  es.addEventListener("unusual", (e) => setUnusual(JSON.parse(e.data)));
  es.addEventListener("muninn", (e) => { S.muninn = JSON.parse(e.data); if (S.selected) renderDrawer(); });
  es.addEventListener("enum", (e) => { const m = JSON.parse(e.data); S.enumer.running = m.running; S.enumPhase = m.phase; if (m.result) S.enumer.results[m.ip] = m.result; if (S.selected) renderDrawer(); });
  es.addEventListener("deeplook", (e) => { const m = JSON.parse(e.data); S.deeplook.running = m.running; if (m.result) S.deeplook.results[m.ip] = m.result; if (S.selected) renderDrawer(); });
  es.addEventListener("scan", (e) => { const m = JSON.parse(e.data); setScan(m); if (m.note && !m.running) toast(esc(m.note)); });
  es.onerror = () => { $("status").textContent = "Lost the connection to Huginn. Trying again."; $("status").className = "off"; };
}

resize();
requestAnimationFrame(draw);
// Connect only once every script file has loaded, so the first live update can't reach
// setHouse / setZones / setUnusual (defined in later files) before they exist.
if (document.readyState === "complete") connect();
else addEventListener("load", connect, { once: true });

// ---------- More (phone): the tools that don't fit on the bottom bar ----------
$("moreBtn").addEventListener("click", () => (S.selected === "more:menu" ? closeDrawer() : openDrawer("more:menu")));
drawerBody.addEventListener("click", (e) => {
  const b = e.target.closest("[data-more]"); if (!b) return;
  const a = b.dataset.more;
  if (a === "live") { $("live").click(); renderDrawer(); }
  if (a === "rewind") $("rewindBtn").click();
  if (a === "log") { closeDrawer(); $("logBtn").click(); }
  if (a === "scan") { closeDrawer(); scanNow(); }
});

// ---------- the one-line answer to "is everything OK at home?" ----------
const homeState = $("homeState");
function renderHomeState() {
  if (!S.loaded) return;
  const alerts = (S.unusual ? S.unusual.findings : []).filter((f) => !f.quiet && !f.seen && !f.done).length;
  const zoneProblems = typeof zoneWarnings === "function" ? zoneDevices().filter((d) => zoneWarnings(d).length).length : 0;
  const down = S.vitals && S.vitals.line && S.vitals.line.level === "down";
  const n = alerts + zoneProblems;
  homeState.className = `homeState ${down || alerts ? "bad" : n ? "warn" : "good"}`;
  homeState.textContent = down ? "The internet is down" : n ? `${n} thing${n === 1 ? "" : "s"} to look at` : S.site ? "All good here" : "All good at home";
  homeState.dataset.go = alerts || !zoneProblems ? "unusual:home" : "zones:home";
}
homeState.addEventListener("click", () => {
  if (homeState.dataset.go === "zones:home" && typeof setZonesOn === "function" && !S.zonesOn) setZonesOn(true);
  openDrawer(homeState.dataset.go || "unusual:home");
});

// ---------- Simple view: bigger, calmer, only the house ----------
S.simple = false;
try { S.simple = localStorage.getItem("huginn.simple") === "1"; } catch { /* private window */ }
function setSimple(on) {
  S.simple = on; document.body.classList.toggle("simple", on);
  try { localStorage.setItem("huginn.simple", on ? "1" : ""); } catch { /* fine */ }
  layout(false);
}
document.body.classList.toggle("simple", S.simple);
drawerBody.addEventListener("click", (e) => { const b = e.target.closest('[data-more="simple"]'); if (b) { setSimple(!S.simple); renderDrawer(); } });

// ---------- Wi-Fi or cable (used by the 3D view to route its packets) ----------
function linkHtml(d) {
  if (!d || !d.mac) return "";
  const opts = [["wifi", "Wi-Fi"], ["cable", "Cable"]];
  return `<h3>Connects by</h3><div class="zoneChips" role="group" aria-label="Connects by">${opts.map(([v, l]) =>
    `<button type="button" data-link="${v}" data-mac="${esc(d.mac)}" aria-pressed="${d.link === v}" style="--zc:var(--frost)">${l}</button>`).join("")}</div>
    ${d.linkChosen ? "" : `<p class="note">Huginn's guess from the kind of device. Tap the right one if it's wrong.</p>`}`;
}
drawerBody.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-link]"); if (!b) return;
  try {
    const r = await fetch("api/devices/link", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mac: b.dataset.mac, link: b.dataset.link }) });
    if (!r.ok) throw new Error((await r.json()).error || "Not saved.");
    toast(b.dataset.link === "cable" ? "Saved: on a cable." : "Saved: on Wi-Fi.");
  } catch (err) { toast(`Couldn't save that: ${esc(err.message)}`); }
});

// ---------- Host check: the newest Muninn report for this computer ----------
S.muninn = {};
function hostCheckHtml(key) {
  const r = S.muninn && S.muninn[key];
  if (!r) return key === "pc" || S.site ? `<h3>Host check</h3><p class="note">No Muninn report for this computer yet. Run muninn\\run-collect.bat on it (as administrator) and it shows up here.</p>` : "";
  const c = r.counts, list = (rows, fmt) => rows.length ? `<ul class="bars plain">${rows.map((x) => `<li><span>${fmt(x)}</span></li>`).join("")}</ul>` : "";
  const nothing = !c.unsigned && !c.startup && !c.tasks && !c.services && !c.userFolders;
  const sections = [
    [c.unsigned, `${c.unsigned} running program${c.unsigned === 1 ? "" : "s"} without a valid signature`, list(r.top.unsigned, (p) => `<b>${esc(p.name)}</b> ${esc(p.path || "")}`), true],
    [c.startup, `${c.startup} startup entr${c.startup === 1 ? "y" : "ies"} (run when someone signs in)`, list(r.top.startup, (x) => `<b>${esc(x.name)}</b> ${esc(x.value || "")}`)],
    [c.tasks, `${c.tasks} scheduled task${c.tasks === 1 ? "" : "s"} running from user folders`, list(r.top.tasks, (x) => `<b>${esc(x.name)}</b> ${esc(x.action || "")}`)],
    [c.services, `${c.services} service${c.services === 1 ? "" : "s"} running from user folders`, list(r.top.services, (x) => `<b>${esc(x.name)}</b> ${esc(x.path || "")}`)],
    [c.userFolders, `${c.userFolders} signed program${c.userFolders === 1 ? "" : "s"} running from user folders (usually fine: Discord, games, updaters)`, ""],
  ].filter(([n]) => n);
  return `<h3>Host check</h3>
    <p class="sub hcWhen">Muninn checked <b>${esc(r.computer)}</b> ${esc(ago(r.time))}${r.isAdmin ? "" : ", without administrator rights, so some things weren't visible"}.</p>
    ${nothing ? `<p class="note">Nothing flagged.</p>` : sections.map(([, title, body, strong]) => body
      ? `<details class="nerd hc${strong ? " strong" : ""}"><summary>${esc(title)}</summary>${body}</details>` : `<p class="note">${esc(title)}</p>`).join("")}
    <p class="note">Things to look at by hand, not a verdict. Full report: muninn\\reports\\${esc(r.report)}\\FLAGS.txt</p>`;
}

// ---------- Deep look: an on-demand nmap scan of one device (opt-in; see the IT review) ----------
S.deeplook = { available: false, running: null, results: {} };
function deepLookHtml(ip) {
  const D = S.deeplook;
  if (!D.available) return "";   // nmap isn't on this computer; the button stays hidden
  const r = D.results[ip], running = D.running === ip, busyElse = D.running && D.running !== ip;
  let body = "";
  if (r) {
    const rows = r.ports.length
      ? `<ul class="bars plain dl">${r.ports.map((p) => `<li><span><b>${p.port}/${esc(p.proto)}</b> ${esc(p.service || "?")}</span><span>${esc([p.product, p.version, p.extra].filter(Boolean).join(" ") || "")}</span></li>`).join("")}</ul>`
      : `<p class="note">No open ports found.</p>`;
    body = `<p class="sub hcWhen">${r.ports.length} open port${r.ports.length === 1 ? "" : "s"}${r.os ? `, looks like ${esc(r.os.name)}` : ""}. Scanned ${esc(ago(r.at))}.</p>${rows}`;
  }
  return `<h3>Deep look (nmap)</h3>
    ${body || `<p class="note">A closer scan of this one device: which ports are open and what's listening. Louder than Huginn's normal look, so only on a network you're allowed to probe.</p>`}
    <div class="actions"><button type="button" data-dl="${esc(ip)}" ${running || busyElse ? "disabled" : ""}>${running ? "Scanning…" : busyElse ? "Another scan is running" : r ? "Scan again" : "Run a deep look"}</button></div>`;
}
drawerBody.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-dl]"); if (!b) return;
  const ip = b.dataset.dl;
  S.deeplook.running = ip; renderDrawer();
  try {
    const res = await fetch("api/deeplook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ip }) });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || "Scan failed.");
    S.deeplook.results[ip] = j;
  } catch (err) { toast(`Deep look: ${esc(err.message)}`); }
  S.deeplook.running = null; renderDrawer();
});

// ---------- Enumerate: Huginn's own deep scan of one device (no external tools) ----------
S.enumer = { running: null, results: {} };
const ENUM_PHASE = { start: "Starting…", ports: "Scanning ports…", probing: "Checking services…", service: "Checking services…", host: "Asking the device who it is…" };
function svcLine(s) {
  if (s.http) {
    const bits = [s.http.server, s.http.poweredBy, s.http.title ? `“${s.http.title}”` : null, s.http.realm ? `login: ${s.http.realm}` : null].filter(Boolean);
    return `HTTP ${s.http.status}${s.http.redirect ? ` → ${s.http.redirect}` : ""}${bits.length ? " · " + bits.join(" · ") : ""}`;
  }
  if (s.tls) {
    const names = (s.tls.altNames || []).slice(0, 4).join(", ");
    return `TLS · ${s.tls.subject || "no name"}${s.tls.selfSigned ? " (self-signed)" : s.tls.issuer ? `, by ${s.tls.issuer}` : ""}${names ? ` · ${names}` : ""}`;
  }
  if (s.banner) return esc(s.banner).slice(0, 160);
  return "open";
}
function enumHtml(ip) {
  const E = S.enumer, r = E.results[ip], running = E.running === ip, busyElse = E.running && E.running !== ip;
  let body = "";
  if (running) body = `<p class="note" role="status">${esc(ENUM_PHASE[S.enumPhase] || "Scanning…")}</p>`;
  else if (r) {
    const id = [];
    if (r.netbios && r.netbios.computer) id.push(`Windows name: <b>${esc(r.netbios.computer)}</b>`);
    if (r.upnp && r.upnp.desc) id.push([r.upnp.desc.manufacturer, r.upnp.desc.modelName].filter(Boolean).map(esc).join(" "));
    else if (r.upnp && r.upnp.server) id.push(esc(r.upnp.server));
    const rows = r.services.length
      ? `<ul class="bars plain dl">${r.services.map((s) => `<li><span><b>${s.port}/${esc(s.proto)}</b></span><span>${svcLine(s)}</span></li>`).join("")}</ul>`
      : `<p class="note">No open ports found.</p>`;
    body = `${id.length ? `<p class="sub hcWhen">${id.join(" · ")}</p>` : ""}
      <p class="sub hcWhen">${r.open.length} open port${r.open.length === 1 ? "" : "s"}. Scanned ${esc(ago(r.at))}.</p>${rows}`;
  } else {
    body = `<p class="note">Huginn's own deep scan: finds open ports and what's listening (web pages, certificates, device names) using only its own code, no extra tools. Read-only, and only on a device you're allowed to probe.</p>`;
  }
  return `<h3>Enumerate</h3>${body}
    <div class="actions"><button type="button" data-enum="${esc(ip)}" ${running || busyElse ? "disabled" : ""}>${running ? "Scanning…" : busyElse ? "Another scan is running" : r ? "Scan again" : "Enumerate this device"}</button></div>`;
}
drawerBody.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-enum]"); if (!b) return;
  const ip = b.dataset.enum;
  S.enumer.running = ip; S.enumPhase = "start"; renderDrawer();
  try {
    const res = await fetch("api/enumerate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ip }) });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || "Scan failed.");
    S.enumer.results[ip] = j;
  } catch (err) { toast(`Enumerate: ${esc(err.message)}`); }
  S.enumer.running = null; renderDrawer();
});
