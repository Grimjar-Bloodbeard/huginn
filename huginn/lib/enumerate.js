// Huginn's own enumeration engine — our code, no external tools, so it runs anywhere the kit does.
// Given ONE local device the operator picks, it: scans a set of TCP ports (our own connect scan),
// then actively but harmlessly probes each open port for what it is (banner, HTTP identity, TLS
// certificate), and asks the host itself who it is (UPnP/SSDP description, NetBIOS name).
//
// Everything here is READ-ONLY reconnaissance: it connects, reads what a service volunteers, and
// closes. No logins, no passwords, no default-credential tries, no exploits, no writes. The caller
// must confirm the target is a local address it is allowed to probe (see lib/deeplook isLocalTarget).
"use strict";
const net = require("net");
const tls = require("tls");
const http = require("http");
const https = require("https");
const dgram = require("dgram");

// ---------- our own TCP connect scan ----------
function tryPort(ip, port, timeout) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const end = (open) => { if (done) return; done = true; sock.destroy(); resolve(open); };
    sock.setTimeout(timeout);
    sock.once("connect", () => end(true));
    sock.once("timeout", () => end(false));
    sock.once("error", () => end(false));
    sock.connect(port, ip);
  });
}
async function scanPorts(ip, ports, { concurrency = 64, timeout = 1500 } = {}) {
  const open = [], queue = ports.slice();
  async function worker() { let p; while ((p = queue.shift()) !== undefined) if (await tryPort(ip, p, timeout)) open.push(p); }
  await Promise.all(Array.from({ length: Math.min(concurrency, ports.length) }, worker));
  return open.sort((a, b) => a - b);
}

// A sensible default port set: common services, merged with any the caller already knows are open.
const COMMON_PORTS = [21, 22, 23, 25, 53, 80, 110, 111, 135, 139, 143, 161, 389, 443, 445, 465, 515, 554,
  587, 631, 993, 995, 1025, 1080, 1433, 1521, 1723, 1883, 1900, 2000, 2049, 2082, 2375, 3000, 3306, 3389,
  4433, 5000, 5060, 5353, 5357, 5432, 5555, 5900, 5984, 6379, 7331, 7777, 8000, 8008, 8009, 8060, 8080,
  8081, 8089, 8123, 8181, 8443, 8554, 8883, 9000, 9090, 9100, 9200, 27017, 32400, 49152, 62078];

// ---------- a generic banner grab ----------
const printable = (buf) => buf.toString("latin1").replace(/[^\x20-\x7e\r\n\t]/g, ".").trim().slice(0, 400);
function grabBanner(ip, port, timeout = 3000) {
  return new Promise((resolve) => {
    const sock = new net.Socket(); let data = Buffer.alloc(0), done = false;
    const end = () => { if (done) return; done = true; sock.destroy(); resolve(data.length ? printable(data) : null); };
    sock.setTimeout(timeout);
    sock.once("connect", () => { setTimeout(() => { if (!data.length) try { sock.write("\r\n"); } catch {} }, 600); });
    sock.on("data", (d) => { data = Buffer.concat([data, d]); if (data.length > 2048) end(); });
    sock.once("timeout", end); sock.once("error", end); sock.once("close", end);
    sock.connect(port, ip);
  });
}

// ---------- HTTP / HTTPS identity ----------
function extractTitle(body) {
  const m = /<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(body);
  return m ? m[1].replace(/\s+/g, " ").trim().slice(0, 120) : null;
}
function summariseHttp(res, body) {
  const h = res.headers || {};
  return {
    status: res.statusCode, server: h.server || null, poweredBy: h["x-powered-by"] || null,
    title: extractTitle(body || ""), realm: (h["www-authenticate"] || "").match(/realm="([^"]*)"/i)?.[1] || null,
    redirect: h.location || null, contentType: (h["content-type"] || "").split(";")[0] || null,
  };
}
function probeHttp(ip, port, secure) {
  return new Promise((resolve) => {
    const mod = secure ? https : http;
    const req = mod.request({ host: ip, port, path: "/", method: "GET", timeout: 4000, servername: undefined,
      rejectUnauthorized: false, headers: { "User-Agent": "Huginn-enum/1", Connection: "close", Accept: "*/*" } }, (res) => {
      const chunks = []; let len = 0;
      res.on("data", (c) => { chunks.push(c); len += c.length; if (len > 65536) req.destroy(); });
      res.on("end", () => resolve(summariseHttp(res, Buffer.concat(chunks).toString("utf8"))));
      res.on("close", () => resolve(summariseHttp(res, Buffer.concat(chunks).toString("utf8"))));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ---------- TLS certificate ----------
function summariseCert(c) {
  if (!c || !c.subject) return null;
  return {
    subject: c.subject.CN || null, issuer: c.issuer ? c.issuer.CN || c.issuer.O || null : null,
    altNames: (c.subjectaltname || "").replace(/DNS:|IP Address:/g, "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 12),
    validFrom: c.valid_from || null, validTo: c.valid_to || null,
    selfSigned: !!(c.subject && c.issuer && c.subject.CN && c.subject.CN === c.issuer.CN),
  };
}
function probeTls(ip, port) {
  return new Promise((resolve) => {
    const opts = { host: ip, port, rejectUnauthorized: false, timeout: 4000 };
    if (!net.isIP(ip)) opts.servername = ip;   // SNI must be a hostname, never an IP
    const sock = tls.connect(opts, () => {
      const cert = sock.getPeerCertificate(false); sock.destroy(); resolve(summariseCert(cert));
    });
    sock.once("error", () => resolve(null));
    sock.once("timeout", () => { sock.destroy(); resolve(null); });
  });
}

// ---------- UPnP / SSDP: ask the network's devices to describe themselves ----------
function parseSsdp(text) {
  const get = (k) => (text.match(new RegExp(`^${k}\\s*:\\s*(.+)$`, "im")) || [])[1]?.trim() || null;
  return { location: get("LOCATION"), server: get("SERVER"), st: get("ST"), usn: get("USN") };
}
function parseDeviceDesc(xml) {
  const tag = (t) => (xml.match(new RegExp(`<${t}>([^<]+)</${t}>`, "i")) || [])[1]?.trim() || null;
  const out = { friendlyName: tag("friendlyName"), manufacturer: tag("manufacturer"),
    modelName: tag("modelName"), modelNumber: tag("modelNumber"), deviceType: tag("deviceType") };
  return Object.values(out).some(Boolean) ? out : null;
}
function fetchText(url, timeout = 3000) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch { return resolve(null); }
    if (u.protocol !== "http:") return resolve(null);
    const req = http.get({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, timeout }, (res) => {
      const c = []; let n = 0; res.on("data", (d) => { c.push(d); n += d.length; if (n > 131072) req.destroy(); });
      res.on("end", () => resolve(Buffer.concat(c).toString("utf8")));
    });
    req.on("error", () => resolve(null)); req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}
// Returns UPnP device descriptions seen on the LAN, keyed by the IP that answered.
function ssdpDiscover({ timeout = 2500 } = {}) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const byIp = new Map();
    const msg = Buffer.from("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\nST: ssdp:all\r\n\r\n");
    sock.on("message", (buf, rinfo) => {
      const s = parseSsdp(buf.toString("latin1"));
      if (!byIp.has(rinfo.address)) byIp.set(rinfo.address, { ip: rinfo.address, server: s.server, location: s.location });
    });
    sock.once("error", () => { try { sock.close(); } catch {} resolve(new Map()); });
    sock.bind(() => { try { sock.send(msg, 1900, "239.255.255.250"); } catch {} });
    setTimeout(async () => {
      try { sock.close(); } catch {}
      for (const [ip, info] of byIp) if (info.location) info.desc = parseDeviceDesc(await fetchText(info.location) || "");
      resolve(byIp);
    }, timeout);
  });
}

// ---------- NetBIOS name (UDP 137): a Windows host will tell you its computer name ----------
function buildNbstat() {
  // A NBSTAT query for the wildcard name "*", the classic node-status request.
  const name = Buffer.alloc(34); name[0] = 0x20;
  const enc = "CKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";   // encoded "*" padded
  for (let i = 0; i < 32; i++) name[1 + i] = enc.charCodeAt(i);
  name[33] = 0x00;
  return Buffer.concat([
    Buffer.from([0x13, 0x37, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    name, Buffer.from([0x00, 0x21, 0x00, 0x01]),
  ]);
}
function parseNbstat(buf) {
  // Answer: after a 12-byte header + echoed question, the RDATA begins with a 1-byte name count,
  // then 18 bytes per entry (15-char name + 1 type + 2 flags).
  try {
    let o = 12; while (o < buf.length && buf[o] !== 0) o += buf[o] + 1; o += 1 + 4;   // skip question name + type/class
    o += 2 + 2 + 2 + 4 + 2;   // name ptr, type, class, ttl, rdlength
    const count = buf[o]; o += 1;
    const names = [];
    for (let i = 0; i < count && o + 18 <= buf.length; i++, o += 18) {
      const nm = buf.toString("latin1", o, o + 15).replace(/[^\x20-\x7e]/g, "").trim();
      const suffix = buf[o + 15], group = (buf[o + 16] & 0x80) !== 0;
      if (nm) names.push({ name: nm, suffix, group });
    }
    const self = names.find((n) => !n.group && n.suffix === 0x00);
    return { computer: self ? self.name : null, names };
  } catch { return null; }
}
function netbiosName(ip, timeout = 2000) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4"); let done = false;
    const end = (v) => { if (done) return; done = true; try { sock.close(); } catch {} resolve(v); };
    sock.on("message", (buf) => end(parseNbstat(buf)));
    sock.on("error", () => end(null));
    sock.send(buildNbstat(), 137, ip, (e) => { if (e) end(null); });
    setTimeout(() => end(null), timeout);
  });
}

// ---------- the orchestrator ----------
const PROBE_PORTS = {   // which active probe to run on which port
  http: [80, 81, 591, 2082, 2375, 3000, 5000, 8000, 8008, 8009, 8060, 8080, 8081, 8089, 8123, 8181, 9000, 9090, 32400],
  https: [443, 4433, 8443, 9443, 8883],
};
async function enumerate(ip, { ports, knownOpen = [], onProgress = () => {}, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const set = Array.from(new Set([...(ports || COMMON_PORTS), ...knownOpen])).sort((a, b) => a - b);
  onProgress({ phase: "ports", total: set.length });
  const open = await scanPorts(ip, set);
  onProgress({ phase: "probing", open });
  const services = [];
  for (const port of open) {
    const svc = { port, proto: "tcp" };
    const secure = PROBE_PORTS.https.includes(port) || port === 443;
    if (secure) { svc.tls = await probeTls(ip, port); svc.http = await probeHttp(ip, port, true); }
    else if (PROBE_PORTS.http.includes(port)) { svc.http = await probeHttp(ip, port, false); }
    else { svc.banner = await grabBanner(ip, port); }
    if (!svc.http && !svc.tls && !svc.banner && !secure) svc.banner = await grabBanner(ip, port);
    services.push(svc);
    onProgress({ phase: "service", port });
  }
  onProgress({ phase: "host" });
  const [nb, ssdp] = await Promise.all([netbiosName(ip), ssdpDiscover()]);
  const upnp = ssdp.get(ip) || null;
  return { ip, at: now(), open, services, netbios: nb, upnp };
}

module.exports = {
  scanPorts, grabBanner, probeHttp, probeTls, netbiosName, ssdpDiscover, enumerate,
  // pure parsers, for tests:
  extractTitle, summariseHttp, summariseCert, parseSsdp, parseDeviceDesc, parseNbstat, buildNbstat,
  COMMON_PORTS,
};
