// Huginn command center: Zones. Sort devices into Trusted, Things, Guests and Quarantine.
// Drag a device onto a zone (or tap a zone in its sheet), read exactly what will change, tap Move.
// Every move lands in the change journal with Undo. Loaded after app.js and shares its names.
"use strict";

S.zonesOn = false;
S.zones = { zones: [], members: {}, journal: [] };
const UNSORTED = { id: null, name: "No zone", color: "#6B7495", rule: "Treated like any other device." };
const SUGGEST_ZONE = { phone: "trusted", tablet: "trusted", computer: "trusted", laptop: "trusted", watch: "trusted", server: "trusted", router: "trusted",
                       tv: "things", console: "things", speaker: "things", camera: "things", plug: "things", chip: "things", printer: "things" };
let zonePick = null;     // the preview being shown: { key, moves, label, to, plan, busy, error }
let zdrag = null, zoneSectors = [];
const zonesBtn = $("zonesBtn");

function zoneInfo(id) {
  if (!id) return UNSORTED;
  const z = S.zones.zones.find((x) => x.id === id) || null;
  if (z && id === "guests" && S.guestWifi) return { ...z, rule: `Visitors. Normal ad blocking. For a real wall, they join the guest Wi-Fi, "${S.guestWifi.name}".` };
  return z;
}
function guestWifiWord() { return S.guestWifi ? `the guest Wi-Fi, "${S.guestWifi.name}"` : "the guest Wi-Fi"; }
function onGuestWifi(d) {   // 192.168.1.0/24 style check against the configured guest network
  const g = S.guestWifi && S.guestWifi.cidr; if (!g || !d || !d.ip) return d && d.role === "guest";
  const [base, bits] = g.split("/"), size = 2 ** (32 - Number(bits));
  const n = (ip) => ip.split(".").reduce((a, x) => a * 256 + Number(x), 0);
  return Math.floor(n(d.ip) / size) === Math.floor(n(base) / size);
}
function zoneOf(d) { return d && d.mac && S.zones.members[d.mac] ? S.zones.members[d.mac].zone : null; }
function suggestFor(d) { return d && d.role === "guest" ? "guests" : SUGGEST_ZONE[d && d.icon] || null; }
function zoneDevices() { return [...S.devices.values()].filter((d) => d.ip && d.mac && d.ip !== S.gateway && !S.localIps.has(d.ip)); }

function setZones(z) {
  if (!z) return;
  S.zones = z;
  renderHomeState();
  if (S.zonesOn) layoutSoon();
  if (S.selected && !zdrag) renderDrawer();
}

// ---------- health: is each device behaving like its zone says? ----------
const BLIND = "The ad blocker can't see";   // a Phase 0 blind spot, not something wrong with the device
const NUDGE = "Its device ID changes";   // a settings nudge, also not a problem
function isNote(t) { return t.startsWith(BLIND) || t.startsWith(NUDGE); }
function zoneWarnings(d) { return zoneIssues(d).filter((t) => !isNote(t)); }
function zoneIssues(d) {
  const z = zoneOf(d); if (!z) return [];
  const out = [], now = Date.now() / 1000, since = S.zones.members[d.mac].t || 0;
  const st = S.lan.get(d.ip), L = S.lookups.get(d.ip);
  if (z !== "trusted" && st && st.opened && st.openedLast > since && now - st.openedLast < 3600) {
    const ports = Object.keys(st.openedPorts || {}).filter((p) => p !== "DNS").slice(0, 3).join(", ");
    if (st.openedPorts && st.openedPorts.DNS) out.push(`Asks ${myName()} for websites: an old ad blocker still running there answers it. The planned router fix stops that.`);
    if (ports) out.push(`Reached into ${myName()}, which is Trusted${ports ? ` (on ${ports})` : ""}.`);
  }
  if (!L || L.last < since) {
    if (now - since > 600) out.push("The ad blocker can't see this device yet: it asks the router for websites instead. The planned router fix solves that.");
  } else if (z === "quarantine" && L.top.some(([, , blocked, last]) => !blocked && last > since + 5)) {
    out.push("The ad blocker let a website through since it went into Quarantine. It may be asking the router for some websites.");
  }
  if (z === "guests" && !onGuestWifi(d)) out.push(`Still on the main Wi-Fi. Join it to ${guestWifiWord()} for a real wall.`);
  if (d.privateMac) out.push("Its device ID changes now and then (a phone privacy setting). Turn off \"private address\" for this Wi-Fi on the device, or it can fall out of its zone.");
  return out;
}

// ---------- the sky: one slice of the inner ring per zone ----------
// Called from app.js layout() while the zones layer is on.
function zoneAngles(list) {
  const groups = [...S.zones.zones, UNSORTED].map((z) => ({ z, ips: [] }));
  for (const ip of list) {
    const zid = zoneOf(S.devices.get(ip));
    (groups.find((g) => g.z.id === zid) || groups[groups.length - 1]).ips.push(ip);
  }
  const start = Math.PI / 2 + 0.5, gap = 0.07, avail = Math.PI * 2 - 1 - gap * (groups.length - 1);
  const weight = (g) => Math.max(g.ips.length, 1.4);   // empty zones keep a slice, so there's somewhere to drop
  const total = groups.reduce((a, g) => a + weight(g), 0);
  const out = new Map(); zoneSectors = [];
  let a = start;
  for (const g of groups) {
    const span = (avail * weight(g)) / total;
    g.ips.forEach((ip, i) => out.set(ip, a + (span * (i + 0.5)) / g.ips.length));
    zoneSectors.push({ id: g.z.id, name: g.z.name, color: g.z.color, start: a, span, n: g.ips.length });
    a += span + gap;
  }
  return out;
}

// Called from app.js draw(), under the nodes.
function drawZoneSectors(s, k) {
  if (!S.zonesOn || S.view === "house") return;
  const inner = R1 * 0.72, outer = R1 * 1.24;
  for (const z of zoneSectors) {
    const hot = zdrag && zdrag.moved && zdrag.over === z;
    ctx.globalAlpha = hot ? 0.24 : 0.07; ctx.fillStyle = z.color;
    ctx.beginPath(); ctx.arc(CX, CY, outer, z.start, z.start + z.span); ctx.arc(CX, CY, inner, z.start + z.span, z.start, true); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = hot ? 1 : 0.65; ctx.strokeStyle = z.color; ctx.lineWidth = (hot ? 3.5 : 2) * k; ctx.lineCap = "round";
    ctx.beginPath(); ctx.arc(CX, CY, outer, z.start + 0.012, z.start + z.span - 0.012); ctx.stroke(); ctx.lineCap = "butt";
    const mid = z.start + z.span / 2, lr = outer + 14 * k, c = Math.cos(mid);
    ctx.globalAlpha = z.id || z.n ? 1 : 0.6; ctx.fillStyle = z.color; ctx.font = font(700, 12.5 * k);
    ctx.textAlign = c > 0.3 ? "left" : c < -0.3 ? "right" : "center"; ctx.textBaseline = "middle";
    const label = `${z.name}  ${z.n}`, tw = ctx.measureText(label).width;
    let lx = CX + c * lr;
    const left = (10 - view.x) / s, right = (W - 10 - view.x) / s;   // the screen's edges, in map units
    const x0 = ctx.textAlign === "left" ? lx : ctx.textAlign === "right" ? lx - tw : lx - tw / 2;
    if (x0 < left) lx += left - x0; else if (x0 + tw > right) lx -= x0 + tw - right;
    ctx.fillText(label, lx, CY + Math.sin(mid) * lr);
  }
  ctx.globalAlpha = 1; ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
}

// Called from app.js drawNode(): a ring in the zone's colour, and a red dot if something's off.
function drawZoneRing(n, d, r, zr) {
  if (!S.zonesOn || !d) return;
  const z = zoneOf(d); if (!z) return;
  ctx.strokeStyle = zoneInfo(z).color; ctx.lineWidth = 2.2 * zr; ctx.globalAlpha = 0.95;
  ctx.beginPath(); ctx.arc(n.x, n.y, r + 3.5 * zr, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
  if (zoneWarnings(d).length) {
    ctx.fillStyle = COLORS.blocked; ctx.beginPath(); ctx.arc(n.x + r * 0.9, n.y - r * 0.9, 3.4 * zr, 0, Math.PI * 2); ctx.fill();
  }
}

// ---------- dragging a device onto a zone (sky view, zones layer on) ----------
function sectorAt(wx, wy) {
  if (Math.hypot(wx - CX, wy - CY) < R1 * 0.3) return null;
  let a = Math.atan2(wy - CY, wx - CX);
  const s0 = zoneSectors.length ? zoneSectors[0].start : 0;
  while (a < s0) a += Math.PI * 2;
  while (a >= s0 + Math.PI * 2) a -= Math.PI * 2;
  return zoneSectors.find((z) => a >= z.start - 0.035 && a <= z.start + z.span + 0.035) || null;
}
sky.addEventListener("pointerdown", (e) => {
  if (!S.zonesOn || S.view === "house") return;
  if (zdrag) { e.stopImmediatePropagation(); return; }
  lastPointer = e.pointerType || "mouse";
  const key = hitTest(e.clientX, e.clientY);
  if (!key || !key.startsWith("lan:")) return;   // empty sky: pan as usual
  const d = S.devices.get(key.slice(4));
  if (!d || !d.mac) return;
  e.stopImmediatePropagation();
  try { sky.setPointerCapture(e.pointerId); } catch { /* synthetic or already gone */ }
  zdrag = { n: nodes.get(key), d, id: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false, over: null };
}, true);
sky.addEventListener("pointermove", (e) => {
  if (!zdrag) return;
  e.stopImmediatePropagation();
  if (e.pointerId !== zdrag.id) return;
  if (!zdrag.moved && Math.hypot(e.clientX - zdrag.sx, e.clientY - zdrag.sy) < 6) return;
  zdrag.moved = true;
  const [wx, wy] = toWorld(e.clientX, e.clientY);
  zdrag.n.x = wx; zdrag.n.y = wy;
  zdrag.over = sectorAt(wx, wy);
}, true);
function endZoneDrag(e) {
  if (!zdrag) return;
  e.stopImmediatePropagation();
  if (e.pointerId !== zdrag.id) return;
  const g = zdrag; zdrag = null;
  if (!g.moved) { openDrawer(g.n.key); return; }
  const to = g.over ? g.over.id : undefined;
  if (to === undefined || to === zoneOf(g.d)) { layout(false); return; }   // dropped nowhere, or where it already was
  openDrawer(g.n.key);
  askMove([{ mac: g.d.mac, zone: to }], deviceName(g.d) || g.d.ip, to);
  layout(false);
}
sky.addEventListener("pointerup", endZoneDrag, true);
sky.addEventListener("pointercancel", endZoneDrag, true);

// ---------- preview, then move ----------
async function askMove(moves, label, to) {
  const my = zonePick = { key: S.selected, moves, label, to, plan: null, busy: false, error: null };
  renderDrawer();
  try {
    const r = await fetch("api/zones/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ moves }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "The ad blocker didn't answer.");
    my.plan = j;
  } catch (err) { my.error = err.message; }
  if (zonePick === my) renderDrawer();
}
async function doMove() {
  const p = zonePick; if (!p || p.busy) return;
  p.busy = true; renderDrawer();
  try {
    const r = await fetch("api/zones/move", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ moves: p.moves }) });
    const j = await r.json();
    if (!r.ok && r.status !== 207) throw new Error(j.error || "Not moved.");
    const done = j.entry.items.length, where = p.to === undefined ? "their zones" : zoneInfo(p.to).name;
    const undo = done ? `<button type="button" data-zundo="${esc(j.entry.id)}">Undo</button>` : "";
    if (j.error) toast(`Moved ${done} of ${p.moves.length}, then stopped: ${esc(j.error)}`, undo);
    else toast(`Moved ${esc(p.label)} to ${esc(where)}.`, undo);
    zonePick = null;
  } catch (err) { p.busy = false; p.error = err.message; }
  renderDrawer();
}
async function undoMove(id) {
  try {
    const r = await fetch("api/zones/undo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Not undone.");
    toast("Undone. Everything is back the way it was.");
  } catch (err) { toast(`Couldn't undo: ${esc(err.message)}`); }
}

function planHtml(p) {
  if (!p || p.key !== S.selected) return "";
  const where = p.to === undefined ? "the suggested zones" : zoneInfo(p.to).name;
  if (p.error) return `<div class="zPlan"><p class="formMsg">${esc(p.error)}</p><div class="row"><button type="button" data-zact="cancel">Close</button></div></div>`;
  if (!p.plan) return `<div class="zPlan"><p class="note">Checking what would change. Nothing is changed yet.</p></div>`;
  const steps = [...p.plan.once, ...p.plan.items.flatMap((i) => i.steps)];
  const nothing = p.plan.items.every((i) => i.same);
  return `<div class="zPlan">
    <p class="lbl">Move ${esc(p.label)} to ${esc(where)}. This is what changes:</p>
    <ol>${steps.map((s) => `<li>${esc(s)}</li>`).join("")}${p.to === "guests" ? `<li>Then, on the device, join ${esc(guestWifiWord())}. That's the real wall; Huginn can't do this part for you.</li>` : ""}</ol>
    <div class="row"><button type="button" class="primary" data-zact="go" ${nothing || p.busy ? "disabled" : ""}>${p.busy ? "Moving" : `Move to ${esc(where)}`}</button><button type="button" data-zact="cancel">Cancel</button></div>
    <p class="note">This changes what your ad blocker (Pi-hole) lets through, not which devices can reach each other. You can undo it any time under Zones, Changes.</p>
  </div>`;
}

// The Zone part of a device's sheet (app.js renderDrawer).
function zoneSectionHtml(d) {
  if (!d || !d.mac) return "";
  const cur = zoneOf(d), z = zoneInfo(cur), issues = zoneIssues(d);
  const chips = [...S.zones.zones, UNSORTED].map((x) =>
    `<button type="button" data-zone="${x.id || "none"}" aria-pressed="${x.id === cur}" style="--zc:${x.color}">${esc(x.name)}</button>`).join("");
  return `<h3>Zone</h3><div class="zoneChips" role="group" aria-label="Zone">${chips}</div>
    <p class="note">${esc(z.rule)}</p>
    ${issues.map((i) => `<p class="${isNote(i) ? "note" : "zIssue"}">${esc(i)}</p>`).join("")}
    ${planHtml(zonePick)}`;
}

// ---------- the Zones sheet: who's where, what's off, and the change journal ----------
function zonesHomeHtml() {
  const devs = zoneDevices(), by = new Map([...S.zones.zones, UNSORTED].map((z) => [z.id, []]));
  for (const d of devs) by.get(zoneOf(d)).push(d);
  const issues = devs.flatMap((d) => zoneWarnings(d).map((t) => [d, t]));
  const blind = devs.filter((d) => zoneIssues(d).some((t) => t.startsWith(BLIND)));
  const sortable = by.get(null).filter((d) => suggestFor(d));
  const row = (d, extra = "") => `<li class="dev" data-key="lan:${esc(d.ip)}">${iconSvg(d.ip === S.piholeIp ? "server" : d.icon, 22)}<span class="dn"><b>${esc(nodeLabel(`lan:${d.ip}`))}</b><small>${esc(d.ip)}${extra}</small></span>${zoneWarnings(d).length ? '<b class="zDot" aria-label="Needs a look"></b>' : ""}</li>`;
  const section = (z) => {
    const list = by.get(z.id);
    if (!z.id && !list.length) return "";
    return `<h3 class="zHead" style="--zc:${z.color}">${esc(z.name)} <span>${list.length}</span></h3>
      <p class="note">${esc(z.rule)}</p>
      ${list.length ? `<ul class="devs">${list.map((d) => row(d, !z.id && suggestFor(d) ? `, looks like ${zoneInfo(suggestFor(d)).name}` : "")).join("")}</ul>` : `<p class="note">Empty. Drag a device onto this slice of the map.</p>`}`;
  };
  const changes = [...S.zones.journal].reverse().slice(0, 12).map((e) => {
    const what = e.items.map((i) => `${i.name} to ${zoneInfo(i.to).name}`).join(", ");
    return `<li><span>${esc(clock(e.t))}: ${esc(what)}${e.error ? " (stopped partway)" : ""}</span>${e.undone ? `<small>Undone</small>` : `<button type="button" data-zundo="${esc(e.id)}">Undo</button>`}</li>`;
  }).join("");
  return `<h2>Zones</h2>
    <p class="sub">Sort devices by how much you trust them. Drag one onto a slice of the map, or open it and pick a zone. You always see what will change first.</p>
    ${sortable.length ? `<div class="actions"><button type="button" class="primary" data-zact="sort">Sort ${sortable.length} for me</button></div>` : ""}
    ${planHtml(zonePick)}
    ${issues.length ? `<h3>Needs a look</h3><ul class="zIssues">${issues.map(([d, t]) => `<li data-key="lan:${esc(d.ip)}"><b>${esc(deviceName(d) || d.ip)}</b> ${esc(t)}</li>`).join("")}</ul>` : ""}
    ${blind.length ? `<p class="note">The ad blocker can't see ${blind.length} of these device${blind.length === 1 ? "" : "s"} yet: they ask the router for websites instead. Their zones start working after the planned router fix.</p>` : ""}
    ${[...S.zones.zones, UNSORTED].map(section).join("")}
    <h3>Changes</h3>${changes ? `<ul class="zJournal">${changes}</ul>` : `<p class="note">Nothing changed yet. Every move shows up here with Undo.</p>`}
    <p class="note">Zones work through your ad blocker today, so they control which websites get through, not walls between devices. Guests get a real wall on the guest Wi-Fi; a firewall box later gives every zone one.</p>`;
}

drawerBody.addEventListener("click", (e) => {
  const zb = e.target.closest("[data-zone]");
  if (zb) {
    const d = S.devices.get(String(S.selected).slice(4)); if (!d) return;
    const to = zb.dataset.zone === "none" ? null : zb.dataset.zone;
    if (to === zoneOf(d)) { zonePick = null; renderDrawer(); return; }
    askMove([{ mac: d.mac, zone: to }], deviceName(d) || d.ip, to); return;
  }
  const za = e.target.closest("[data-zact]");
  if (za) {
    const a = za.dataset.zact;
    if (a === "cancel") { zonePick = null; renderDrawer(); }
    if (a === "go") doMove();
    if (a === "sort") {
      const list = zoneDevices().filter((d) => !zoneOf(d) && suggestFor(d));
      askMove(list.map((d) => ({ mac: d.mac, zone: suggestFor(d) })), `${list.length} devices`, undefined);
    }
    return;
  }
  const u = e.target.closest("[data-zundo]"); if (u) { u.disabled = true; undoMove(u.dataset.zundo); }
});
toasts.addEventListener("click", (e) => { const u = e.target.closest("[data-zundo]"); if (u) { u.disabled = true; undoMove(u.dataset.zundo); } });

// ---------- the button ----------
function setZonesOn(on) {
  S.zonesOn = on;
  zonesBtn.setAttribute("aria-pressed", String(on));
  document.body.classList.toggle("zonesOn", on);
  try { localStorage.setItem("huginn.zones", on ? "1" : ""); } catch { /* private window */ }
  layout(false);
}
zonesBtn.addEventListener("click", () => {
  if (!S.zonesOn) { setZonesOn(true); openDrawer("zones:home"); }
  else if (S.selected !== "zones:home") openDrawer("zones:home");
  else { setZonesOn(false); closeDrawer(); }
});
try { if (localStorage.getItem("huginn.zones") === "1") setTimeout(() => setZonesOn(true), 60); } catch { /* fine */ }
