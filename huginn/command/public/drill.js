// drill.js - Practice drill: a SAFE, synthetic attack simulation (a trainer).
//
// It injects FAKE events into this browser's view only - a made-up device, made-up
// sparks, made-up lookups - so the map lights up and you can practice spotting an
// attack and deciding what to do. It never touches the network, never sends anything,
// and removes every fake thing when you stop. Nothing here is real.
//
// Classic script: shares app.js globals (S, nodes, node, place, addSparks, toast,
// layout, CX, CY, R1, R2, COLORS, openDrawer, closeDrawer).
(function () {
  const FAKE = { devices: [], hosts: [], lookups: [], hi: [] };
  const timers = [];
  let active = null;
  let banner = null, hud = null, t0 = 0;

  function mk(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function ensureUI() {
    if (!banner) { banner = mk("div", "drillBanner"); banner.hidden = true; document.body.appendChild(banner); banner.addEventListener("click", (e) => { if (e.target.closest("[data-drill-stop]")) stop(); }); }
    if (!hud) { hud = mk("div", "drillHud"); hud.hidden = true; document.body.appendChild(hud); hud.addEventListener("click", onHud); }
  }
  const now = () => Date.now() / 1000;
  function after(ms, fn) { const id = setTimeout(fn, ms); timers.push(id); return id; }
  function every(ms, fn) { const id = setInterval(fn, ms); timers.push(id); return id; }

  // ---- fake world ----
  function spawnDevice(ip, label, icon, opts) {
    opts = opts || {};
    S.devices.set(ip, { ip, mac: "DRILL-" + ip, label, name: label, icon, vendor: "(simulated)", role: opts.role || "", link: opts.link || "wifi",
      firstSeen: now(), lastSeen: now(), status: "", _drill: true });
    S.lan.set(ip, { in: 1, out: 0, chatter: opts.chatter || 0, last: now(), ports: {}, _drill: true });
    FAKE.devices.push(ip);
    if (typeof layout === "function") layout(false);
  }
  function spawnHost(ip, name, org) {
    S.hosts.set(ip, { ip, name, org, in: 0, out: 0, pkts: 0, progs: {}, ports: {}, first: now(), last: now(), _drill: true });
    FAKE.hosts.push(ip);
  }
  function light(key) { if (S.highlight) { S.highlight.add(key); FAKE.hi.push(key); } }
  function setLookups(ip, rows, blocked) {
    S.lookups.set(ip, { total: rows.length * 4, blocked: blocked || 0, last: now(), top: rows.map((d) => [d, 4, false, now()]) });
    FAKE.lookups.push(ip);
  }
  // emit one tick of sparks (each item: from-key -> to-key, kind, bytes)
  function spark(pairs) { if (typeof addSparks === "function") addSparks(pairs.map((p) => ({ s: p[0], d: p[1], k: p[2], b: p[3], t: now() }))); }
  // some real device keys on the map to aim traffic at, so routes exist
  function realTargets(n) {
    const ips = [];
    for (const [ip, d] of S.devices) { if (d._drill) continue; if (ip === S.gateway) continue; if (S.localIps && S.localIps.has(ip)) continue; ips.push(ip); if (ips.length >= n) break; }
    return ips;
  }

  // ---- scenarios ----
  const SCENARIOS = {
    killchain: {
      title: "Attack from outside - the whole path",
      blurb: "Watch an attacker on the internet work in from your router, get a foothold, spread, and steal - the usual order a real break-in follows.",
      run(say) {
        const atk = "203.0.113.66", atkName = "scanner-cloud-7.example", victim = "10.0.0.143", router = "router";
        spawnHost(atk, atkName, "Attacker (simulated)");
        light("net:" + atk);
        say("Step 1 of 6 - Recon. An attacker out on the internet is scanning your router, your front door, looking for a way in.");
        toast("Simulated alert: outside host probing the router.");
        const recon = every(650, () => spark([["net:" + atk, router, "in", 90]]));
        after(6000, () => {
          say("Step 2 - Break-in. They hammer the router's exposed service with known passwords and a known exploit.");
          toast("Simulated alert: repeated login attempts from outside.");
        });
        after(12000, () => {
          clearInterval(recon);
          spawnDevice(victim, "desk-pc-14", "computer", {});
          light("lan:" + victim);
          say("Step 3 - Foothold. One machine falls. The attacker is now INSIDE your network - see the path run from outside, through the router, to that PC.");
          toast("Simulated alert: a device looks compromised.");
          every(900, () => spark([["net:" + atk, "lan:" + victim, "in", 160]]));
        });
        after(19000, () => {
          say("Step 4 - Phone home. The infected PC beacons back out to the attacker on a steady timer, waiting for orders.");
          every(2500, () => spark([["lan:" + victim, "net:" + atk, "out", 80]]));
        });
        after(25000, () => {
          say("Step 5 - Spread. From that one PC they scan and hop sideways to your other machines. This is lateral movement.");
          toast("Simulated alert: internal scan from the compromised PC.");
          every(700, () => { const t = realTargets(5); spark(t.map((x) => ["lan:" + victim, "lan:" + x, "lan", 110])); });
        });
        after(31000, () => {
          say("Step 6 - Steal. Finally they haul your data out - a big upload from the PC, through the router, to their server.");
          every(650, () => spark([["lan:" + victim, "net:" + atk, "out", 4200]]));
        });
        after(38000, () => debrief([
          ["The chain", "Recon &rarr; break-in &rarr; foothold &rarr; phone-home &rarr; spread &rarr; steal. Almost every real intrusion walks these steps in this order."],
          ["Break it early", "You do not have to catch step 1. Quarantine the <b>first</b> odd device (the foothold) and every step after it stops."],
          ["Where Huginn sees it", "Outside probing the router, a device talking to an unknown host on a timer, an internal scan, a big outbound upload - each stage is one of its alerts."],
          ["Your move", "Open the flagged PC, <b>Enumerate</b> to confirm, <b>Quarantine</b> to cut it off, then clean the host. The earlier you cut, the less they reach."],
        ]));
      },
    },
    rogue: {
      title: "Rogue device + port scan",
      blurb: "A device you have never seen joins the Wi-Fi and starts knocking on every door of your other devices.",
      run(say) {
        const ip = "10.0.0.207";
        say("A new, unnamed device just joined on Wi-Fi: " + ip + ".");
        spawnDevice(ip, "unknown-207", "unknown", { role: "guest" });
        toast("Simulated alert: a new device joined the network.");
        after(3500, () => {
          say("Now it is connecting to port after port on your other devices. That is a port scan - it is mapping what is here.");
          toast("Simulated alert: burst of connections (possible scan).");
          every(600, () => { const t = realTargets(6); spark(t.map((x) => ["lan:" + ip, "lan:" + x, "lan", 120])); });
        });
        after(16000, () => say("A scan from an unknown device is the classic first move of an intruder. In a moment: what you would do about it."));
        after(22000, () => debrief([
          ["Confirm", "Open the device and hit <b>Enumerate</b> to see what it is and which ports it is probing."],
          ["Contain", "If it is not yours, move it to the <b>Quarantine</b> zone (kills its DNS) or pull it off the Wi-Fi."],
          ["Learn", "A brand-new device that immediately scans is almost never friendly. Name your known devices so a stranger stands out."],
        ]));
      },
    },
    beacon: {
      title: "Command-and-control beacon",
      blurb: "An infected-looking device phones a strange server on a steady heartbeat - the signature of malware checking in for orders.",
      run(say) {
        const ip = "10.0.0.158", c2 = "185.220.101.44", dom = "cdn-update-7731.duckdns.example";
        say("A device is reaching out to a server nobody recognises: " + dom + ".");
        spawnDevice(ip, "lab-pc-03", "computer", {});
        spawnHost(c2, dom, "Unknown (suspicious)");
        setLookups(ip, [dom, dom, dom], 0);
        toast("Simulated alert: a device is talking to a brand-new, unknown site.");
        let beat = 0;
        every(2600, () => { beat++; spark([["lan:" + ip, "net:" + c2, "out", 90], ["net:" + c2, "lan:" + ip, "in", 140]]); if (beat === 3) say("See the rhythm? Every few seconds, like clockwork. People browse in bursts; malware beacons on a timer."); });
        after(20000, () => debrief([
          ["Confirm", "Open the device, read its <b>websites asked for</b> - a random-looking domain it hits on a schedule is the tell."],
          ["Contain", "Move it to <b>Quarantine</b>. It blocks the DNS, so the malware cannot reach its server even though the PC stays on."],
          ["Learn", "Steady, timed connections to an unknown domain = command-and-control. The regularity is the giveaway, not the volume."],
        ]));
      },
    },
    exfil: {
      title: "Data being stolen (exfiltration)",
      blurb: "A device suddenly pushes a large, sustained upload out to an outside server - data leaving that should not be.",
      run(say) {
        const ip = "10.0.0.161", dst = "45.133.9.12", dom = "store-backup-eu.example";
        say("A device just started a big upload to an outside server: " + dom + ".");
        spawnDevice(ip, "front-desk-pc", "computer", {});
        spawnHost(dst, dom, "Unknown (suspicious)");
        toast("Simulated alert: unusually large upload leaving the network.");
        every(700, () => spark([["lan:" + ip, "net:" + dst, "out", 4200]]));
        after(5000, () => say("Notice it is almost all going OUT, and it does not stop. Normal use pulls down far more than it pushes up."));
        after(20000, () => debrief([
          ["Confirm", "Open the device: a steady, heavy <b>up</b> flow to one outside server is what exfiltration looks like."],
          ["Contain", "<b>Quarantine</b> it to stop the upload, then check the host (what program is sending)."],
          ["Learn", "Watch the direction. A machine uploading hard for a long time, to somewhere you do not know, is a red flag."],
        ]));
      },
    },
  };

  // ---- UI ----
  function open() {
    ensureUI();
    if (typeof closeDrawer === "function") closeDrawer();
    hud.classList.remove("running");
    hud.innerHTML =
      '<div class="dhHead"><b>Practice drill</b><button type="button" class="dhX" data-drill-close aria-label="Close">x</button></div>' +
      '<p class="dhLead">Pick a scenario. Huginn will fake an attack so you can see it on the map and practice responding. It is all simulated - nothing touches your network.</p>' +
      '<div class="dhList">' +
      Object.entries(SCENARIOS).map(([id, s]) => '<button type="button" data-drill="' + id + '"><b>' + s.title + '</b><span>' + s.blurb + '</span></button>').join("") +
      '</div>';
    hud.hidden = false;
  }
  function onHud(e) {
    const pick = e.target.closest("[data-drill]");
    if (pick) return start(pick.dataset.drill);
    if (e.target.closest("[data-drill-close]")) { hud.hidden = true; return; }
    if (e.target.closest("[data-drill-again]")) { stop(); return open(); }
    if (e.target.closest("[data-drill-stop]")) return stop();
  }
  function start(id) {
    const sc = SCENARIOS[id]; if (!sc) return;
    stop(true);                // clear any prior fakes but keep UI
    active = id; t0 = Date.now();
    banner.innerHTML = 'DRILL - simulated. Nothing real is happening on your network. <button type="button" data-drill-stop>Stop drill</button>';
    banner.hidden = false;
    hud.classList.add("running");
    renderRun(sc, "Starting the simulation...");
    sc.run((line) => renderRun(sc, line));
  }
  function renderRun(sc, line) {
    hud.innerHTML =
      '<div class="dhHead"><span class="dhDot"></span><b>' + sc.title + '</b><button type="button" class="dhX" data-drill-stop aria-label="Stop">Stop</button></div>' +
      '<p class="dhNarr">' + line + '</p>' +
      '<p class="dhSim">Simulated - safe to watch. Try opening the flagged device on the map.</p>';
  }
  function debrief(steps) {
    if (!active) return;
    const sc = SCENARIOS[active];
    hud.innerHTML =
      '<div class="dhHead"><b>' + sc.title + ' - what to do</b><button type="button" class="dhX" data-drill-stop aria-label="Stop">Stop</button></div>' +
      '<ol class="dhSteps">' + steps.map((s) => '<li><b>' + s[0] + ':</b> ' + s[1] + '</li>').join("") + '</ol>' +
      '<div class="dhBtns"><button type="button" data-drill-again>Run another</button><button type="button" class="primary" data-drill-stop>Done</button></div>';
  }
  function stop(keepUI) {
    for (const id of timers.splice(0)) { clearTimeout(id); clearInterval(id); }
    for (const ip of FAKE.devices.splice(0)) { S.devices.delete(ip); S.lan.delete(ip); }
    for (const ip of FAKE.hosts.splice(0)) S.hosts.delete(ip);
    for (const ip of FAKE.lookups.splice(0)) S.lookups.delete(ip);
    for (const key of FAKE.hi.splice(0)) if (S.highlight) S.highlight.delete(key);
    active = null;
    if (typeof layout === "function") layout(false);
    if (banner) banner.hidden = true;
    if (!keepUI && hud) hud.hidden = true;
  }

  window.Drill = { open, start, stop };
  // clean up if the tab is closing
  addEventListener("pagehide", () => stop());
})();
