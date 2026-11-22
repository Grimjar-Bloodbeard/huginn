// Huginn command center: Unusual. What doesn't fit a device's usual pattern, from its Pi-hole lookups.
// The first week is learning (logged, no alerts). Nothing becomes normal unless you tap it.
// Loaded after app.js and zones.js and shares their names.
"use strict";

S.unusual = { started: null, learnUntil: null, findings: [] };
S.flagged = new Set();   // device addresses with an open finding (red ring on the map)
const unusualBtn = $("unusualBtn");
let knownFids = null;
const ufOpen = new Set();   // which folded lists are open, so live refreshes keep them open
drawerBody.addEventListener("toggle", (e) => { const k = e.target.dataset && e.target.dataset.u; if (k) e.target.open ? ufOpen.add(k) : ufOpen.delete(k); }, true);

function findingDevice(f) {
  return [...S.devices.values()].find((d) => d.mac && d.mac === f.id) || S.devices.get(f.ip) || null;
}
function findingName(f) { const d = findingDevice(f); return (d && deviceName(d)) || f.ip || "A device"; }
function isOpen(f) { return !f.quiet && !f.seen && !f.done; }

function setUnusual(u) {
  if (!u) return;
  S.unusual = u;
  const open = u.findings.filter(isOpen);
  S.flagged = new Set(open.map((f) => { const d = findingDevice(f); return d ? d.ip : f.ip; }).filter(Boolean));
  unusualBtn.querySelector(".count").textContent = open.length || "";
  unusualBtn.classList.toggle("alert", open.length > 0);
  if (knownFids) {
    for (const f of open) if (!knownFids.has(f.fid)) {
      toast(`<b>${esc(findingName(f))}</b>: ${esc(f.title)}`, `<button type="button" data-open="unusual:home">Look</button>`);
    }
  }
  knownFids = new Set(u.findings.map((f) => f.fid));
  renderHomeState();
  if (pendingHash) { const h = pendingHash; pendingHash = null; setTimeout(() => openFromHash(h), 300); }   // the first update means devices are in
  if (S.selected === "unusual:home" || (S.selected && S.selected.startsWith("lan:"))) renderDrawer();
}

// Called from app.js drawNode(): a slow red ring around a device with an open finding.
function drawFlag(n, r, zr, ts) {
  const p = reduceMotion ? 0.6 : (Math.sin(ts / 900) + 1) / 2;
  ctx.strokeStyle = `rgba(255,93,115,${0.45 + p * 0.45})`; ctx.lineWidth = 2.4 * zr;
  ctx.beginPath(); ctx.arc(n.x, n.y, r + (7 + p * 3) * zr, 0, Math.PI * 2); ctx.stroke();
}

function findingHtml(f, actions = true) {
  const d = findingDevice(f), ip = d ? d.ip : f.ip;
  const sites = f.sites && f.sites.length > 1 ? `<p class="ufD">${f.sites.map(esc).join(", ")}</p>` : "";
  const btns = !actions ? "" : `<div class="row">
      ${!f.done ? `<button type="button" data-uf="normal" data-id="${esc(f.fid)}">That's normal</button>` : ""}
      ${!f.done && f.kind === "new-site" ? `<button type="button" data-uf="house" data-id="${esc(f.fid)}">Normal for the whole house</button>` : ""}
      ${!f.seen && !f.done ? `<button type="button" data-uf="seen" data-id="${esc(f.fid)}">Seen it</button>` : ""}
      <button type="button" data-uf="replay" data-t="${Math.floor(f.t) - 30}">Replay</button>
      ${d && d.mac && !f.done ? `<button type="button" data-uf="quarantine" data-ip="${esc(ip)}">Quarantine</button>` : ""}
    </div>`;
  return `<li class="uf${f.done ? " done" : ""}">
    <p class="ufT">${ip ? `<a data-key="lan:${esc(ip)}">${esc(findingName(f))}</a>` : `<b>${esc(findingName(f))}</b>`} ${esc(f.title)}</p>
    <p class="ufD">${esc(clock(f.t))}, ${esc(ago(f.t))}${f.detail && f.kind !== "new-site" ? `. ${esc(f.detail)}` : ""}${f.done === "normal" ? ". You said this is normal." : ""}</p>
    ${sites}${btns}</li>`;
}

function unusualHomeHtml() {
  const U = S.unusual, all = [...U.findings].reverse();
  const open = all.filter(isOpen), quiet = all.filter((f) => f.quiet && !f.done), past = all.filter((f) => !f.quiet && (f.seen || f.done));
  const learning = U.learnUntil && Date.now() / 1000 < U.learnUntil;
  renderHomeState();
  const intro = !U.started ? "Waiting for the ad blocker. Huginn learns each device's usual habits from the websites it asks for."
    : learning ? `Learning what's normal until ${day(U.learnUntil)}. Until then findings are only logged (below), with no alerts.`
    : "What doesn't fit each device's usual pattern. Nothing becomes normal unless you say so.";
  return `<h2>Alerts</h2><p class="sub">${esc(intro)}</p>
    ${open.length ? `<div class="actions"><button type="button" data-uf="seen" data-id="all">Mark all seen</button></div>
      <ul class="ufs">${open.map((f) => findingHtml(f)).join("")}</ul>` : `<p class="note">${learning ? "No alerts while learning." : "Nothing unusual right now."}</p>`}
    ${quiet.length ? `<details class="ufMore" data-u="quiet" ${ufOpen.has("quiet") ? "open" : ""}><summary>Logged while learning (${quiet.length})</summary><ul class="ufs">${quiet.slice(0, 60).map((f) => findingHtml(f)).join("")}</ul></details>` : ""}
    ${past.length ? `<details class="ufMore" data-u="past" ${ufOpen.has("past") ? "open" : ""}><summary>Earlier (${past.length})</summary><ul class="ufs">${past.slice(0, 60).map((f) => findingHtml(f)).join("")}</ul></details>` : ""}
    <h3>What Huginn looks for</h3>
    <ul class="ufHow">
      <li>A device that keeps to a few sites suddenly reaching new ones, flagged harder when nothing else in the house uses them. Phones and computers are left out; they meet new sites all day.</li>
      <li>A device busy at an hour it almost never is.</li>
      <li>A sudden rush of website requests, or of blocked ones, far above its usual.</li>
    </ul>
    ${alertsHtml()}
    <p class="note">Learned through your ad blocker (Pi-hole), so it only sees devices that ask it for websites. The planned router fix brings in the rest.</p>`;
}

function unusualDeviceHtml(d, ip) {
  const mine = S.unusual.findings.filter((f) => (d && d.mac && f.id === d.mac) || f.ip === ip).reverse().slice(0, 3);
  if (!mine.length) return "";
  return `<h3>Unusual</h3><ul class="ufs">${mine.map((f) => findingHtml(f, isOpen(f))).join("")}</ul>
    <p class="note"><a data-key="unusual:home">All findings</a></p>`;
}

async function unusualPost(path, body) {
  try {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Not saved.");
    return true;
  } catch (err) { toast(`Couldn't save that: ${esc(err.message)}`); return false; }
}
drawerBody.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-uf]"); if (!b) return;
  const a = b.dataset.uf;
  if (a === "replay") { startReplay(Number(b.dataset.t)); return; }
  if (a === "quarantine") {
    const d = S.devices.get(b.dataset.ip); if (!d) return;
    if (!S.zonesOn) setZonesOn(true);
    openDrawer(`lan:${d.ip}`); askMove([{ mac: d.mac, zone: "quarantine" }], deviceName(d) || d.ip, "quarantine");
    return;
  }
  b.disabled = true;
  if (a === "normal" || a === "house") { if (await unusualPost("api/unusual/normal", { id: b.dataset.id, scope: a === "house" ? "house" : "device" })) toast("Got it. Huginn won't flag that again."); }
  if (a === "seen") await unusualPost("api/unusual/seen", { id: b.dataset.id });
});
unusualBtn.addEventListener("click", () => (S.selected === "unusual:home" ? closeDrawer() : openDrawer("unusual:home")));

// ---------- phone alerts ----------
const pushState = { supported: "serviceWorker" in navigator && "PushManager" in window && isSecureContext, on: false, busy: false, msg: "" };
let swReg = null;
if (pushState.supported) {
  navigator.serviceWorker.register("sw.js").then(async (reg) => {
    swReg = reg;
    const sub = await reg.pushManager.getSubscription();
    pushState.on = !!sub;
    if (S.selected === "unusual:home") renderDrawer();
  }).catch(() => { pushState.supported = false; });
  navigator.serviceWorker.addEventListener("message", (e) => { if (e.data && e.data.open) openFromHash(e.data.open); });
}
function keyBytes(b64) {
  const s = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
async function pushOn() {
  if (await Notification.requestPermission() !== "granted") {
    if (navigator.brave) throw new Error("Brave blocks web alerts until you turn one setting on: Settings, Privacy and security, \"Use Google services for push messaging\". Then tap the icon left of the address, allow Notifications for this site, and try again. (Or open Huginn in Chrome.)");
    throw new Error("Notifications are blocked for Huginn. Tap the icon left of the address, allow Notifications, then try again.");
  }
  const { publicKey } = await (await fetch("api/push/key")).json();
  const sub = await (swReg || await navigator.serviceWorker.ready).pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  const r = await fetch("api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sub: sub.toJSON() }) });
  if (!r.ok) throw new Error((await r.json()).error || "Huginn didn't keep it.");
  pushState.on = true; pushState.msg = "Alerts are on for this device.";
}
async function pushOff() {
  const sub = swReg && await swReg.pushManager.getSubscription();
  if (sub) {
    await fetch("api/push/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
    await sub.unsubscribe();
  }
  pushState.on = false; pushState.msg = "Alerts are off for this device.";
}
async function pushTest() {
  const r = await fetch("api/push/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "Not sent.");
  pushState.msg = `Sent to ${j.sent} device${j.sent === 1 ? "" : "s"}. It should pop up in a few seconds.`;
}
function alertsHtml() {
  if (navigator.userAgent.includes("HuginnApp/")) {
    return `<h3>Alerts on this device</h3><p class="note">The Huginn app can't take alerts yet; that's the next step for the app. Until then, open Huginn in Chrome once and turn alerts on there. They'll still pop up on this phone.</p>`;
  }
  if (!pushState.supported) {
    const ios = /iPhone|iPad/.test(navigator.userAgent);
    return `<h3>Alerts on this device</h3><p class="note">${ios ? "On iPhone, add Huginn to the Home screen first, then open it from there." : "This browser can't take alerts here. Open Huginn through its Tailscale address on your phone."}</p>`;
  }
  return `<h3>Alerts on this device</h3>
    <p class="note">A notification when something unusual turns up (after learning ends) or a new device joins. Only a short note leaves Huginn, encrypted, through your phone's own push service.</p>
    <div class="actions">${pushState.on
      ? `<button type="button" data-push="test" ${pushState.busy ? "disabled" : ""}>Send a test</button><button type="button" data-push="off" ${pushState.busy ? "disabled" : ""}>Turn off alerts</button>`
      : `<button type="button" class="primary" data-push="on" ${pushState.busy ? "disabled" : ""}>Turn on alerts</button>`}</div>
    ${pushState.msg ? `<p class="note" role="status">${esc(pushState.msg)}</p>` : ""}`;
}
drawerBody.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-push]"); if (!b || pushState.busy) return;
  pushState.busy = true; pushState.msg = ""; renderDrawer();
  try { await ({ on: pushOn, off: pushOff, test: pushTest })[b.dataset.push](); }
  catch (err) { pushState.msg = err.message; }
  pushState.busy = false; renderDrawer();
});

// ---------- opening a sheet from a link or an alert (#unusual, #lan:192.168.1.13) ----------
let pendingHash = location.hash.slice(1) || null;
function openFromHash(h) {
  if (!h) return;
  if (h === "unusual") openDrawer("unusual:home");
  else if (h.startsWith("lan:") && S.devices.has(h.slice(4))) openDrawer(h);
}
addEventListener("hashchange", () => openFromHash(location.hash.slice(1)));
