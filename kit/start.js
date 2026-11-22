// Ravens kit launcher: starts Odin's Watch (maps the network) and Huginn (the command center) from this
// folder, with every setting and every file kept here, then opens Huginn in the browser.
// Uses the kit's own Node and Python (runtime\) when they're on the stick, otherwise the PC's own.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const KIT = path.resolve(__dirname, "..");
const SITE_DIR = path.join(KIT, "site");
const SITE_FILE = path.join(SITE_DIR, "huginn.config.json");
const HUGINN_PORT = Number(process.env.HUGINN_PORT || 33613);
const ODIN_PORT = Number(process.env.ODIN_PORT || 7331);
const say = (s) => console.log(s);

function findPython() {
  const own = path.join(KIT, "runtime", "python", "python.exe");
  if (fs.existsSync(own)) return { exe: own, own: true };
  for (const exe of ["py", "python", "python3"]) {
    const r = spawnSync(exe, ["-c", "import flask, zeroconf; print('ok')"], { encoding: "utf8", windowsHide: true });
    if (r.stdout && r.stdout.includes("ok")) return { exe, own: false };
  }
  return null;
}

// The lab's network: this PC's own private address, as a /24. Skips virtual adapters and VPNs.
function detectSubnet() {
  const skip = /virtual|vmware|vbox|hyper-v|wsl|vethernet|tailscale|loopback|bluetooth/i;
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (skip.test(name)) continue;
    for (const a of list || []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) continue;
      const p = a.address.split(".");
      return { cidr: `${p[0]}.${p[1]}.${p[2]}.0/24`, gateway: `${p[0]}.${p[1]}.${p[2]}.1`, me: a.address, adapter: name };
    }
  }
  return null;
}

// Before mapping anything: has whoever runs this network said yes? Asked once; the answer is kept.
async function askPermission() {
  if (process.env.RAVENS_PERMISSION) return { by: process.env.RAVENS_PERMISSION, at: new Date().toISOString() };
  const rl = require("readline").createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a.trim())));
  say("Before Huginn maps this network:");
  say("Do you have signed permission from whoever runs it (often IT, not only the teacher)?");
  const yes = await ask("Type YES if you do: ");
  if (yes.toUpperCase() !== "YES") { rl.close(); say("\nStopping. Nothing was scanned. Get permission first, then start again."); process.exit(0); }
  const by = await ask("Who gave permission (name and role, for your own records): ");
  rl.close();
  return { by: by || "not given", at: new Date().toISOString() };
}

async function firstRun() {
  if (fs.existsSync(SITE_FILE)) return JSON.parse(fs.readFileSync(SITE_FILE, "utf8"));
  const permission = await askPermission();
  const net = detectSubnet();
  if (!net) { say("Couldn't find this PC's network. Is it connected?"); process.exit(1); }
  fs.mkdirSync(SITE_DIR, { recursive: true });
  const site = { siteName: process.env.SITE_NAME || "the lab", odinDevicesFile: path.join(KIT, "odin", "network_topology.json"), permission };
  fs.writeFileSync(SITE_FILE, JSON.stringify(site, null, 2));
  // Odin's Watch: scan only this one /24, and show its dashboard on this PC only.
  const odinCfgFile = path.join(KIT, "odin", "config.json");
  const odinCfg = JSON.parse(fs.readFileSync(odinCfgFile, "utf8"));
  odinCfg.subnets = [{ name: "Lab network", role: "trusted", cidr: net.cidr, gateway: net.gateway, color: "#39ffb0" }];
  fs.writeFileSync(odinCfgFile, JSON.stringify(odinCfg, null, 2));
  say(`First run: this PC is ${net.me} on ${net.adapter}. Huginn will map ${net.cidr}.`);
  say(`To change the name or the network, edit site\\huginn.config.json and odin\\config.json, then start again.\n`);
  return site;
}

function start(name, exe, args, opts) {
  const p = spawn(exe, args, { ...opts, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const log = fs.createWriteStream(path.join(SITE_DIR, `${name}.log`), { flags: "a" });
  p.stdout.pipe(log); p.stderr.pipe(log);
  p.on("exit", (code) => say(`${name} stopped (code ${code}). Its log: site\\${name}.log`));
  return p;
}

(async () => {
  say("Ravens kit: Odin's Watch maps the network, Huginn shows it.\n");
  const site = await firstRun();
  const py = findPython();
  if (!py) say("No Python with Flask found, so Odin's Watch can't start. Put the kit's runtime folder back, or install Python and run: pip install flask zeroconf");
  const kids = [];
  if (py) {
    kids.push(start("odin", py.exe, ["app.py"], { cwd: path.join(KIT, "odin"), env: { ...process.env, ODIN_PORT: String(ODIN_PORT), ODIN_HOST: "127.0.0.1" } }));
    say(`Odin's Watch: http://127.0.0.1:${ODIN_PORT}  (${py.own ? "the kit's Python" : "this PC's Python"})`);
  }
  const env = { ...process.env, HUGINN_CONFIG: SITE_FILE, HUGINN_DATA: path.join(SITE_DIR, "huginn-data"), MUNINN_REPORTS: path.join(KIT, "muninn", "reports"),
                ODIN_URL: `http://127.0.0.1:${ODIN_PORT}`, HUGINN_PORT: String(HUGINN_PORT) };
  if (py) env.HUGINN_PYTHON = py.own ? py.exe : (spawnSync(py.exe, ["-c", "import sys; print(sys.executable)"], { encoding: "utf8", windowsHide: true }).stdout || "").trim();
  kids.push(start("huginn", process.execPath, [path.join(KIT, "huginn", "command", "server.js")], { cwd: path.join(KIT, "huginn"), env }));
  const url = `http://127.0.0.1:${HUGINN_PORT}`;
  say(`Huginn: ${url}  (watching ${site.siteName})\n`);
  setTimeout(() => { if (!process.env.NO_BROWSER) spawn("cmd", ["/c", "start", "", url], { windowsHide: true, detached: true, stdio: "ignore" }).unref(); }, 2500);
  say("Live packet sparks need Npcap installed on this PC (see README.txt). Everything else works without it.");
  say("Close this window, or press Ctrl+C, to stop both.");
  const stop = () => { for (const k of kids) { try { k.kill(); } catch { /* gone */ } } process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
})();
