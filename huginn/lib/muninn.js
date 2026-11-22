// Muninn's host checks, read into Huginn. Muninn (run on each computer from the stick) leaves a report
// folder per run: host.json says which computer, flags.json lists what looked odd. Huginn shows the
// newest report for each computer in that device's sheet. Read-only: Huginn never runs Muninn itself.
"use strict";
const fs = require("fs");
const path = require("path");

function readJsonFile(f) {
  try { return JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, "")); } catch { return null; }
}
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);   // PowerShell writes a single item as an object

// Older reports have no host.json: the computer's name is in 00-host.txt.
function hostFromText(dir) {
  try {
    const t = fs.readFileSync(path.join(dir, "00-host.txt"), "utf8");
    const get = (k) => (t.match(new RegExp(`^${k}\\s*:\\s*(.+)$`, "m")) || [])[1];
    return { computer: (get("Computer") || "").trim(), user: (get("User") || "").trim(), os: (get("OS") || "").trim(), time: (get("Time") || "").trim(), isAdmin: /true/i.test(get("IsAdmin") || ""), addresses: [] };
  } catch { return null; }
}

// One report folder -> a summary, or null if it isn't a finished report.
function readReport(dir) {
  if (!fs.existsSync(path.join(dir, "DONE.txt"))) return null;
  const host = readJsonFile(path.join(dir, "host.json")) || hostFromText(dir);
  if (!host || !host.computer) return null;
  const f = readJsonFile(path.join(dir, "flags.json")) || {};
  const processes = list(f.processes), runKeys = list(f.runKeys), tasks = list(f.tasks), services = list(f.services);
  const unsigned = processes.filter((p) => p.sig && p.sig !== "Valid");
  return {
    report: path.basename(dir), computer: String(host.computer), user: host.user || null, os: host.os || null,
    time: Date.parse(host.time) / 1000 || fs.statSync(dir).mtimeMs / 1000, isAdmin: !!host.isAdmin,
    addresses: list(host.addresses).map((a) => ({ ip: a.ip || null, mac: a.mac ? String(a.mac).toUpperCase() : null, adapter: a.adapter || null })),
    hasFlags: !!f.report,
    counts: { unsigned: unsigned.length, userFolders: processes.length - unsigned.length, startup: runKeys.length, tasks: tasks.length, services: services.length },
    top: {
      unsigned: unsigned.slice(0, 12).map((p) => ({ name: p.name, path: p.path, sig: p.sig })),
      startup: runKeys.slice(0, 12).map((r) => ({ name: r.name, value: r.value })),
      tasks: tasks.slice(0, 12).map((t) => ({ name: t.name, action: t.action })),
      services: services.slice(0, 12).map((s) => ({ name: s.name, path: s.path, state: s.state })),
    },
  };
}

// The newest finished report for each computer.
function readReports(root) {
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name)); } catch { return []; }
  const newest = new Map();
  for (const d of dirs.sort()) {
    const r = readReport(d); if (!r) continue;
    const k = r.computer.toUpperCase();
    if (!newest.has(k) || newest.get(k).time <= r.time) newest.set(k, r);
  }
  return [...newest.values()];
}

// Which device on the map a report belongs to: hardware ID first, then address, then name.
function matchReport(r, devices, localIps = []) {
  const macs = new Set(r.addresses.map((a) => a.mac).filter(Boolean)), ips = new Set(r.addresses.map((a) => a.ip).filter(Boolean));
  if (r.addresses.some((a) => localIps.includes(a.ip))) return "pc";
  let d = devices.find((x) => x.mac && macs.has(x.mac.toUpperCase())) || devices.find((x) => x.ip && ips.has(x.ip));
  if (!d) { const n = r.computer.toLowerCase(); d = devices.find((x) => [x.hostname, x.name].some((h) => h && String(h).toLowerCase().split(".")[0] === n)); }
  return d ? `lan:${d.ip}` : null;
}

module.exports = { readReports, readReport, matchReport };
