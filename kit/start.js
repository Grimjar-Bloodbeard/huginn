// Ravens kit launcher: starts Odin's Watch (maps the network) and Huginn (the command center) from this
// folder, with every setting and every file kept here, then opens Huginn in the browser.
// Windows: uses the kit's own Node and Python (runtime\) when they're on the stick, otherwise the PC's own.
// Linux / Termux: run through the `huginn` command that install.sh sets up (it points HUGINN_PYTHON at
// Huginn's own Python environment).
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
let PLAT;   // kit layout (kit\ next to huginn\), or the source tree (kit\ next to lib\)
try { PLAT = require(path.join(__dirname, "..", "huginn", "lib", "platform")); } catch { PLAT = require(path.join(__dirname, "..", "lib", "platform")); }

const KIT = path.resolve(__dirname, "..");
const SITE_DIR = path.join(KIT, "site");
const SITE_FILE = path.join(SITE_DIR, "huginn.config.json");
const HUGINN_PORT = Number(process.env.HUGINN_PORT || 33613);
const ODIN_PORT = Number(process.env.ODIN_PORT || 7331);
const rel = (...p) => path.join(...p);   // shows paths with this OS's separator
const say = (s) => console.log(s);

function hasFlask(exe) {
  const r = spawnSync(exe, ["-c", "import flask, zeroconf; print('ok')"], { encoding: "utf8", windowsHide: true });
  return !!(r.stdout && r.stdout.includes("ok"));
}
function findPython() {
  if (process.env.HUGINN_PYTHON && fs.existsSync(process.env.HUGINN_PYTHON) && hasFlask(process.env.HUGINN_PYTHON)) {
    return { exe: process.env.HUGINN_PYTHON, own: true };
  }
  const own = PLAT.IS_WIN ? path.join(KIT, "runtime", "python", "python.exe") : path.join(KIT, "venv", "bin", "python3");
  if (fs.existsSync(own)) return { exe: own, own: true };
  for (const exe of PLAT.IS_WIN ? ["py", "python", "python3"] : ["python3", "python"]) {
    if (hasFlask(exe)) return { exe, own: false };
  }
  return null;
}

// The network: this machine's own private address, as a /24. Skips virtual adapters, containers and VPNs.
const SKIP = /virtual|vmware|vbox|hyper-v|wsl|vethernet|tailscale|loopback|bluetooth|^lo$|^docker|^br-|^veth|^virbr|^tun|^tap|^wg|^zt/i;
const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
function asNet(ip, adapter, gateway) {
  const p = ip.split(".");
  return { cidr: `${p[0]}.${p[1]}.${p[2]}.0/24`, gateway: gateway || `${p[0]}.${p[1]}.${p[2]}.1`, me: ip, adapter };
}
async function detectSubnet() {
  const route = PLAT.IS_WIN ? null : PLAT.linuxDefaultRoute();   // Linux knows its real router; Windows we guess .1
  try {
    const all = Object.entries(os.networkInterfaces());
    // Prefer the adapter that carries the default route, then any other real one.
    if (route) all.sort(([a], [b]) => (b === route.iface) - (a === route.iface));
    for (const [name, list] of all) {
      if (SKIP.test(name)) continue;
      for (const a of list || []) {
        if (a.family !== "IPv4" || a.internal || !PRIVATE.test(a.address)) continue;
        const gw = route && route.iface === name && route.gateway && route.gateway.split(".").slice(0, 3).join(".") === a.address.split(".").slice(0, 3).join(".") ? route.gateway : null;
        return asNet(a.address, name, gw);
      }
    }
  } catch { /* newer Android blocks this list; ask the routing table instead */ }
  const ip = await PLAT.localIpViaRoute();
  if (ip && PRIVATE.test(ip)) return asNet(ip, "default route", route && route.gateway);
  return null;
}

// Before mapping anything: has whoever runs this network said yes? Asked once; the answer is kept.
async function askPermission() {
  if (process.env.RAVENS_PERMISSION) return { by: process.env.RAVENS_PERMISSION, at: new Date().toISOString() };
  const rl = require("readline").createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a.trim())));
  say("Before Huginn maps this network:");
  say("Is this your own network, or do you have signed permission from whoever runs it (often IT, not only a teacher)?");
  const yes = await ask("Type YES if so: ");
  if (yes.toUpperCase() !== "YES") { rl.close(); say("\nStopping. Nothing was scanned. Get permission first, then start again."); process.exit(0); }
  const by = await ask("Whose network is it / who gave permission (for your own records): ");
  rl.close();
  return { by: by || "not given", at: new Date().toISOString() };
}

async function firstRun() {
  if (fs.existsSync(SITE_FILE)) return JSON.parse(fs.readFileSync(SITE_FILE, "utf8"));
  const permission = await askPermission();
  const net = await detectSubnet();
  if (!net) { say("Couldn't find this machine's network. Is it connected?"); process.exit(1); }
  fs.mkdirSync(SITE_DIR, { recursive: true });
  const site = { siteName: process.env.SITE_NAME || "the lab", odinDevicesFile: path.join(KIT, "odin", "network_topology.json"), permission };
  fs.writeFileSync(SITE_FILE, JSON.stringify(site, null, 2));
  // Odin's Watch: scan only this one /24, and show its dashboard on this machine only.
  const odinCfgFile = path.join(KIT, "odin", "config.json");
  const odinCfg = JSON.parse(fs.readFileSync(odinCfgFile, "utf8"));
  odinCfg.subnets = [{ name: "Local network", role: "trusted", cidr: net.cidr, gateway: net.gateway, color: "#39ffb0" }];
  fs.writeFileSync(odinCfgFile, JSON.stringify(odinCfg, null, 2));
  say(`First run: this machine is ${net.me} on ${net.adapter}, router ${net.gateway}. Huginn will map ${net.cidr}.`);
  say(`To change the name or the network, edit ${rel("site", "huginn.config.json")} and ${rel("odin", "config.json")} in ${KIT}, then start again.\n`);
  return site;
}

function start(name, exe, args, opts) {
  const p = spawn(exe, args, { ...opts, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const log = fs.createWriteStream(path.join(SITE_DIR, `${name}.log`), { flags: "a" });
  p.stdout.pipe(log); p.stderr.pipe(log);
  p.on("error", (e) => say(`${name} couldn't start: ${e.message}`));
  p.on("exit", (code) => say(`${name} stopped (code ${code}). Its log: ${rel(SITE_DIR, name + ".log")}`));
  return p;
}

function openBrowser(url) {
  if (process.env.NO_BROWSER) return;
  const cmd = PLAT.openUrlCommand(url);
  if (!cmd) { say(`Open ${url} in a browser on this machine.`); return; }
  try {
    const p = spawn(cmd[0], cmd[1], { windowsHide: true, detached: true, stdio: "ignore" });
    p.on("error", () => say(`Open ${url} in a browser on this machine.`));
    p.unref();
  } catch { say(`Open ${url} in a browser on this machine.`); }
}

(async () => {
  say("Huginn: Odin's Watch maps the network, Huginn shows it.\n");
  const site = await firstRun();
  const py = findPython();
  if (!py) say(PLAT.IS_WIN
    ? "No Python with Flask found, so Odin's Watch can't start. Put the kit's runtime folder back, or install Python and run: pip install flask zeroconf"
    : "No Python with Flask found, so Odin's Watch can't start. Re-run install.sh to rebuild Huginn's Python environment.");
  const kids = [];
  if (py) {
    kids.push(start("odin", py.exe, ["app.py"], { cwd: path.join(KIT, "odin"), env: { ...process.env, ODIN_PORT: String(ODIN_PORT), ODIN_HOST: "127.0.0.1" } }));
    say(`Odin's Watch: http://127.0.0.1:${ODIN_PORT}  (${py.own ? "Huginn's own Python" : "this machine's Python"})`);
  }
  const env = { ...process.env, HUGINN_CONFIG: SITE_FILE, HUGINN_DATA: path.join(SITE_DIR, "huginn-data"), MUNINN_REPORTS: path.join(KIT, "muninn", "reports"),
                ODIN_URL: `http://127.0.0.1:${ODIN_PORT}`, HUGINN_PORT: String(HUGINN_PORT) };
  if (py) env.HUGINN_PYTHON = py.own ? py.exe : (spawnSync(py.exe, ["-c", "import sys; print(sys.executable)"], { encoding: "utf8", windowsHide: true }).stdout || "").trim();
  kids.push(start("huginn", process.execPath, [path.join(KIT, "huginn", "command", "server.js")], { cwd: path.join(KIT, "huginn"), env }));
  const url = `http://127.0.0.1:${HUGINN_PORT}`;
  say(`Huginn: ${url}  (watching ${site.siteName})\n`);
  setTimeout(() => openBrowser(url), 2500);
  say(PLAT.IS_WIN
    ? "Live packet sparks need Npcap (see README.txt, or run Enable-Capture.bat). Everything else works without it."
    : PLAT.IS_TERMUX
      ? "On a phone, live packet sparks aren't possible without root. The map and the Practice drill work."
      : "Live packet sparks need capture permission once: run  huginn capture   Everything else works without it.");
  say(PLAT.IS_WIN ? "Close this window, or press Ctrl+C, to stop both." : "Press Ctrl+C to stop both.");
  const stop = () => { for (const k of kids) { try { k.kill(); } catch { /* gone */ } } process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
})();
