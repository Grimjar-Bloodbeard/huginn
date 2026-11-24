// Each operating system reports the same facts (ping time, bytes per second, which program owns
// a port, where the router is) in a different shape. These helpers turn each shape into one answer,
// so the server can run on Windows, Linux, and (best effort) Android/Termux. Pure parsers are
// exported so they can be tested against real sample output on any machine.
"use strict";
const fs = require("fs");
const dgram = require("dgram");

const IS_WIN = process.platform === "win32";
const IS_TERMUX = !!process.env.TERMUX_VERSION || /com\.termux/.test(process.env.PREFIX || "");

// ---------- ping ----------
// Windows: "time=12ms" or "time<1ms". Linux/macOS: "time=12.3 ms".
function pingArgs(host) { return IS_WIN ? ["-n", "1", "-w", "1000", host] : ["-c", "1", "-W", "1", host]; }
function parsePing(out) {
  const m = /time\s*([=<])\s*([\d.]+)\s*ms/i.exec(out || "");
  if (!m) return null;
  return m[1] === "<" ? 0.5 : Number(m[2]);
}

// ---------- bytes on the wire (Linux: /proc/net/dev) ----------
const SKIP_LINUX_IFACE = /^(lo|docker|br-|veth|virbr|tailscale|tun|tap|wg|zt|vmnet|vboxnet|dummy|rmnet_data\d+_?ipa)/i;
function parseProcNetDev(text) {
  const out = {};
  for (const line of String(text || "").split("\n")) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const name = line.slice(0, i).trim();
    if (!name || /\s/.test(name) || name === "face") continue;
    const f = line.slice(i + 1).trim().split(/\s+/).map(Number);
    if (f.length < 9 || !Number.isFinite(f[0]) || !Number.isFinite(f[8])) continue;
    out[name] = { rx: f[0], tx: f[8] };
  }
  return out;
}
// Busiest real adapter between two readings, in bytes per second.
function rates(prev, next, seconds) {
  let down = 0, up = 0;
  for (const [name, n] of Object.entries(next)) {
    if (SKIP_LINUX_IFACE.test(name)) continue;
    const p = prev[name]; if (!p) continue;
    const d = (n.rx - p.rx) / seconds, u = (n.tx - p.tx) / seconds;
    if (d >= 0) down = Math.max(down, d);
    if (u >= 0) up = Math.max(up, u);
  }
  return { down, up };
}

// ---------- which program owns a port (Linux: `ss -tunapH`) ----------
// tcp ESTAB 0 0 192.168.1.5:43210 140.82.112.4:443 users:(("firefox",pid=1234,fd=99))
function parseSs(text) {
  const map = new Map();
  for (const line of String(text || "").split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 6) continue;
    const proto = cols[0].toLowerCase();
    if (proto !== "tcp" && proto !== "udp") continue;
    const local = cols[4];
    const port = local.slice(local.lastIndexOf(":") + 1);
    const who = /users:\(\("([^"]+)"/.exec(line);
    if (who && /^\d+$/.test(port)) map.set(`${proto}:${port}`, who[1]);
  }
  return map;
}

// ---------- the router (Linux: /proc/net/route) ----------
// Default route rows have Destination 00000000; Gateway is little-endian hex (0101A8C0 = 192.168.1.1).
function hexToIp(hex) {
  const n = parseInt(hex, 16);
  if (!Number.isFinite(n)) return null;
  return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join(".");
}
function parseProcRoute(text) {
  let best = null;
  for (const line of String(text || "").split("\n").slice(1)) {
    const c = line.trim().split(/\s+/);
    if (c.length < 8 || c[1] !== "00000000" || c[2] === "00000000") continue;
    if (SKIP_LINUX_IFACE.test(c[0])) continue;
    const metric = Number(c[6]) || 0;
    if (!best || metric < best.metric) best = { iface: c[0], gateway: hexToIp(c[2]), metric };
  }
  return best;
}
function linuxDefaultRoute() {
  try { return parseProcRoute(fs.readFileSync("/proc/net/route", "utf8")); } catch { return null; }
}

// ---------- this machine's own address ----------
// os.networkInterfaces() is blocked on newer Android (Termux). Asking the OS which address it would
// use to reach a test address answers the same question without sending a single packet
// (connecting a UDP socket only picks a route). 192.0.2.1 is a documentation address.
function localIpViaRoute() {
  return new Promise((resolve) => {
    let s;
    try { s = dgram.createSocket("udp4"); } catch { return resolve(null); }
    const done = (v) => { try { s.close(); } catch { /* closed */ } resolve(v); };
    s.on("error", () => done(null));
    try {
      s.connect(9, "192.0.2.1", () => { try { done(s.address().address); } catch { done(null); } });
    } catch { done(null); }
  });
}

// ---------- opening the browser ----------
function openUrlCommand(url) {
  if (IS_WIN) return ["cmd", ["/c", "start", "", url]];
  if (process.platform === "darwin") return ["open", [url]];
  if (IS_TERMUX) return ["termux-open-url", [url]];
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return ["xdg-open", [url]];
  return null;   // a server or SSH session: no screen to open a browser on
}

module.exports = { IS_WIN, IS_TERMUX, pingArgs, parsePing, parseProcNetDev, rates, parseSs,
  hexToIp, parseProcRoute, linuxDefaultRoute, localIpViaRoute, openUrlCommand, SKIP_LINUX_IFACE };
