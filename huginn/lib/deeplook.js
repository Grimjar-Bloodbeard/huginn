// "Deep look": an optional, on-demand nmap scan of ONE device the user picks. Never part of the
// automatic sweep (that stays a quiet ping sweep). Only runs against a local-network address, so Huginn
// can't be pointed at the internet. Parsing is separate from running, so it can be tested without nmap.
"use strict";
const fs = require("fs");
const path = require("path");

// nmap is not bundled. Use it only if it's already on the machine (or a configured path).
function findNmap(config = {}) {
  const tries = [config.nmapPath, process.env.NMAP_PATH,
    "C:/Program Files (x86)/Nmap/nmap.exe", "C:/Program Files/Nmap/nmap.exe",
    "/usr/bin/nmap", "/usr/local/bin/nmap", "/opt/homebrew/bin/nmap"].filter(Boolean);
  for (const t of tries) { try { if (fs.existsSync(t)) return t; } catch { /* keep looking */ } }
  return null;   // the server also checks PATH with a spawn, for "nmap" on PATH
}

// Only private / local addresses. A public address is refused, so this can't become an internet scanner.
function isLocalTarget(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ""));
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return false;
  return (
    o[0] === 10 ||
    (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
    (o[0] === 192 && o[1] === 168) ||
    (o[0] === 169 && o[1] === 254) ||          // link-local
    o[0] === 127                                // the machine itself
  );
}

// A deliberately modest, admin-free scan: TCP connect, light version detection, common ports.
function nmapArgs(ip, { os = false, topPorts = 200 } = {}) {
  const a = ["-sT", "-sV", "--version-light", "-T4", "-Pn", "--host-timeout", "90s",
             "--top-ports", String(Math.min(1000, Math.max(20, topPorts | 0)) || 200), "-oX", "-"];
  if (os) a.push("-O");   // OS guess; needs admin/raw sockets, fails gracefully if not elevated
  a.push(ip);
  return a;
}

// nmap's XML is simple and regular. Pull out ports, services and any OS guess without an XML library.
function attr(tag, name) {
  const m = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return m ? m[1].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : null;
}
function parseNmapXml(xml) {
  xml = String(xml || "");
  const host = (xml.match(/<host[\s>][\s\S]*?<\/host>/) || [""])[0];
  const addr = attr((host.match(/<address[^>]*addrtype="ipv4"[^>]*\/>/) || [""])[0], "addr");
  const stateTag = host.match(/<status[^>]*\/>/);
  const up = stateTag ? attr(stateTag[0], "state") === "up" : /<port[\s>]/.test(host);
  const ports = [];
  for (const pm of host.matchAll(/<port\b([^>]*)>([\s\S]*?)<\/port>/g)) {
    const head = pm[1], inner = pm[2];
    const st = (inner.match(/<state[^>]*\/>/) || [""])[0];
    if (attr(st, "state") !== "open") continue;
    const sv = (inner.match(/<service[^>]*\/?>/) || [""])[0];
    ports.push({
      port: Number(attr(head, "portid")), proto: attr(head, "protocol") || "tcp",
      service: attr(sv, "name") || null, product: attr(sv, "product") || null,
      version: attr(sv, "version") || null, extra: attr(sv, "extrainfo") || null,
    });
  }
  ports.sort((a, b) => a.port - b.port);
  const osm = host.match(/<osmatch[^>]*\/?>/);
  const os = osm ? { name: attr(osm[0], "name"), accuracy: Number(attr(osm[0], "accuracy")) || null } : null;
  const finished = xml.match(/<finished[^>]*summary="([^"]*)"/);
  const err = xml.match(/<\/?nmaprun/) ? null : "nmap gave no usable output";
  return { ip: addr, up, ports, os, summary: finished ? attr(finished[0], "summary") : null, error: err };
}

// Validates a request body from the page.
function checkDeepLook(body, devices = [], subnets = []) {
  const ip = String((body && body.ip) || "");
  if (!isLocalTarget(ip)) return { ok: false, error: "Deep look only runs on a device on this network." };
  const inSubnet = subnets.some((s) => s.cidr && sameSubnet(ip, s.cidr));
  const known = devices.some((d) => d.ip === ip);
  if (subnets.length && !inSubnet && !known) return { ok: false, error: "That address isn't on a network Huginn is watching." };
  return { ok: true, ip, os: !!(body && body.os) };
}
function sameSubnet(ip, cidr) {
  const [base, bitsS] = String(cidr).split("/"); const bits = Number(bitsS);
  if (!isLocalTarget(ip) || !Number.isFinite(bits)) return false;
  const n = (s) => s.split(".").reduce((a, x) => a * 256 + (Number(x) || 0), 0);
  const size = 2 ** (32 - bits);
  return Math.floor(n(ip) / size) === Math.floor(n(base) / size);
}

module.exports = { findNmap, isLocalTarget, nmapArgs, parseNmapXml, checkDeepLook, sameSubnet };
