// Huginn command center: the floor plan ("House" view).
// Add floors (basement to attic), add rooms with one tap or draw them, then place each device:
// tap "Place devices" and tap where each one goes. Sparks and Rewind play over your home.
// Loaded after app.js and shares its top-level names.
"use strict";

S.view = "sky";
S.house = { floors: [], places: {} };
S.floor = null;
S.houseEdit = false;
S.placing = null;          // { queue: [node keys], i, last } while placing devices by tapping

const PLAN_W = 1000, PLAN_H = 700;
const LAB_FLOORS = ["Lab", "Second lab", "Server room", "Other floor"];
const HOME_FLOORS = ["Basement", "Main floor", "Upstairs", "Attic", "Garage", "Other floor"];
function roomPresets() { return S.site ? LAB_ROOMS : HOME_ROOMS; }   // a lab gets benches and racks, a home gets rooms
function floorPresets() { return S.site ? LAB_FLOORS : HOME_FLOORS; }
const LAB_ROOMS = ["Bench", "Row", "Teacher's desk", "Rack", "Printer area", "Server closet", "Room"];
const HOME_ROOMS = ["Living room", "Kitchen", "Bedroom", "Bathroom", "Office", "Dining room", "Laundry", "Garage", "Hallway", "Utility room", "Room"];
let selRoom = null, hdrag = null, otherGroups = [], confirmDelFloor = false, saveTimer = null, savePending = false, addingFloor = false;
let trayBox = null, lastDeleted = null;
toasts.addEventListener("click", (e) => {
  if (!e.target.closest("[data-room-undo]") || !lastDeleted) return;
  const f = S.house.floors.find((x) => x.id === lastDeleted.floor);
  if (f) { f.rooms.splice(Math.min(lastDeleted.i, f.rooms.length), 0, lastDeleted.room); saveHouse(); renderPanel(); toast(`${esc(lastDeleted.room.name)} is back.`); }
  lastDeleted = null;
});
const housePanel = $("housePanel"), houseBtn = $("houseBtn");

function uid() { return Math.random().toString(36).slice(2, 10); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function snap10(v) { return Math.round(v / 10) * 10; }

function curFloor() {
  if (!S.house.floors.length) S.house.floors.push({ id: "ground", name: "Main floor", rooms: [] });   // saved on first edit
  return S.house.floors.find((f) => f.id === S.floor) || S.house.floors[0];
}

// The plan's box in world units (at zoom 1, world = screen pixels).
function planFrame() {
  // Desktop: centred between the flight log on the left and the line readings on the right.
  const left = NARROW ? 0 : (W < 1100 ? 330 : 420), right = NARROW ? W : W - 320, mid = NARROW ? W / 2 : (left + right) / 2;
  const pw = Math.min(R2 * 2.3, NARROW ? W - 24 : right - left - 40, (H - (NARROW ? 330 : 320)) / 0.72);
  const u = pw / PLAN_W, ph = PLAN_H * u;
  return { u, w: pw, h: ph, x0: mid - pw / 2, y0: CY - ph / 2 - (NARROW ? 20 : 30) };
}

// Which entry in the plan a node is stored under: the router, this PC, or a device's hardware address.
function placeKey(n) {
  if (n.key === "router" || n.key === "pc") return n.key;
  if (n.kind === "lan") {
    const ip = n.key.slice(4), d = S.devices.get(ip);
    return d && d.mac ? d.mac : `ip:${ip}`;
  }
  return null;
}
function hasReach(n) {   // routers and access points get a soft circle for roughly where Wi-Fi reaches
  if (n.key === "router") return true;
  if (n.kind !== "lan") return false;
  const d = S.devices.get(n.key.slice(4));
  return !!(d && d.icon === "router");
}
function roomAt(f, px, py) {
  return f.rooms.filter((r) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h).sort((a, b) => a.w * a.h - b.w * b.h)[0] || null;
}
// Devices not on any floor yet, the router and this PC first, named ones before unknown ones.
function unplaced() {
  const out = [];
  for (const n of nodes.values()) {
    const k = placeKey(n); if (!k) continue;
    const pl = S.house.places[k];
    if (!pl || !S.house.floors.some((f) => f.id === pl.floor)) out.push(n);
  }
  const rank = (n) => (n.key === "router" ? 0 : n.key === "pc" ? 1 : n.kind === "lan" && S.devices.get(n.key.slice(4)) ? 2 : 3);
  return out.sort((a, b) => rank(a) - rank(b) || String(nodeLabel(a.key)).localeCompare(String(nodeLabel(b.key))));
}

// Called at the end of app.js layout() while the House view is on.
function houseLayout(snap) {
  const P = planFrame(), f = curFloor(), places = S.house.places;
  const others = new Map();
  for (const n of nodes.values()) {
    n.inTray = false; n.elsewhere = null;
    if (n.kind === "net" || n.kind === "net-hidden" || n.kind === "org") {
      const a = hash(n.key) * Math.PI * 2, r = 0.35 + 0.65 * hash(n.key + "r");
      place(n, P.x0 + P.w * 0.8 + Math.cos(a) * 140 * P.u * r, P.y0 - 62 * P.u + Math.sin(a) * 28 * P.u * r, snap);
      n.angle = -Math.PI / 2;
      continue;
    }
    if (n.kind === "cast") continue;
    const key = placeKey(n); if (!key) continue;
    const pl = places[key];
    n.angle = Math.PI / 2;
    if (pl && pl.floor === f.id) place(n, P.x0 + pl.x * P.u, P.y0 + pl.y * P.u, snap);
    else if (pl && S.house.floors.some((x) => x.id === pl.floor)) {
      if (!others.has(pl.floor)) others.set(pl.floor, []);
      others.get(pl.floor).push(n); n.elsewhere = pl.floor;
    }
  }
  const router = nodes.get("router"), cast = nodes.get("cast");
  if (router && cast) place(cast, router.tx + 26, router.ty - 26, snap);

  // Not placed yet. Desktop: rows under the plan (drag them on while editing).
  // Phone: one small cluster, so nothing ends up under the bottom bar. "Place devices" walks through them.
  const tray = unplaced(), current = S.placing && S.placing.queue[S.placing.i];
  const top = P.y0 + P.h + (NARROW ? 36 : 54);
  if (NARROW) {
    const cw = Math.min(P.w, 240), cx = P.x0 + P.w / 2;
    trayBox = { x: cx - cw / 2, y: top - 14, w: cw, h: 44 };
    tray.forEach((n) => {
      if (n.key === current) place(n, cx, top + 6, snap);
      else place(n, cx + (hash(n.key) - 0.5) * cw, top + (hash(n.key + "y") - 0.5) * 24, snap);
      n.inTray = true;
    });
  } else {
    trayBox = null;
    const gap = 60, per = Math.max(4, Math.floor(P.w / gap));
    tray.forEach((n, i) => {
      const row = Math.floor(i / per), col = i % per;
      place(n, P.x0 + (col + 0.5) * (P.w / per), top + row * 40, snap);
      n.inTray = true;
    });
  }

  // Devices on other floors gather in a little group over the plan's top-right, one per floor.
  otherGroups = [];
  let i = 0;
  for (const [fid, list] of others) {
    const gx = P.x0 + P.w - 40 - i * 120, gy = P.y0 + 34;
    list.forEach((n) => place(n, gx + (hash(n.key) - 0.5) * 50, gy + (hash(n.key + "y") - 0.5) * 22, snap));
    otherGroups.push({ name: (S.house.floors.find((x) => x.id === fid) || {}).name || "Another floor", n: list.length, x: gx, y: gy });
    i++;
  }
}

// Called from app.js draw() instead of the rings while the House view is on.
function drawHouse(s, k) {
  const P = planFrame(), f = curFloor(), u = P.u, placing = !!S.placing;
  ctx.save();
  ctx.fillStyle = placing ? "rgba(26,39,71,0.55)" : "rgba(10,17,36,0.55)"; ctx.fillRect(P.x0, P.y0, P.w, P.h);
  ctx.strokeStyle = S.houseEdit ? "rgba(182,147,255,0.6)" : placing ? "rgba(127,224,180,0.75)" : "rgba(43,59,99,0.95)";
  ctx.lineWidth = (placing ? 2 : 1.2) * k; ctx.setLineDash([4 * k, 6 * k]); ctx.strokeRect(P.x0, P.y0, P.w, P.h); ctx.setLineDash([]);
  if (S.houseEdit) {
    ctx.fillStyle = "rgba(233,229,217,0.10)";
    for (let x = 50; x < PLAN_W; x += 50) for (let y = 50; y < PLAN_H; y += 50) ctx.fillRect(P.x0 + x * u - k, P.y0 + y * u - k, 2 * k, 2 * k);
  }
  // the floor plan picture you uploaded, fitted inside the plan, under everything else
  const pic = f.image && planPicture(f.image.file);
  if (pic && pic.complete && pic.naturalWidth) {
    const fit = Math.min(P.w / pic.naturalWidth, P.h / pic.naturalHeight), iw = pic.naturalWidth * fit, ih = pic.naturalHeight * fit;
    ctx.globalAlpha = f.image.opacity; ctx.drawImage(pic, P.x0 + (P.w - iw) / 2, P.y0 + (P.h - ih) / 2, iw, ih); ctx.globalAlpha = 1;
  }
  // Wi-Fi reach (a rough circle, not a measurement)
  for (const n of nodes.values()) {
    if (!hasReach(n) || n.inTray || n.elsewhere) continue;
    const r = 240 * u, g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r);
    g.addColorStop(0, "rgba(127,224,180,0.16)"); g.addColorStop(1, "rgba(127,224,180,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fill();
  }
  // Rooms
  ctx.textAlign = "left"; ctx.textBaseline = "top";
  const handle = (NARROW ? 9 : 6) * k;
  for (const r of f.rooms) {
    const x = P.x0 + r.x * u, y = P.y0 + r.y * u, w = r.w * u, h = r.h * u, on = S.houseEdit && selRoom === r.id;
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 6 * Math.min(1, k * 2));
    ctx.fillStyle = on ? "rgba(182,147,255,0.10)" : "rgba(26,39,71,0.62)"; ctx.fill();
    ctx.strokeStyle = on ? COLORS.bone : "rgba(134,214,255,0.34)"; ctx.lineWidth = (on ? 2 : 1.2) * k; ctx.stroke();
    ctx.font = font(600, 12.5 * k); ctx.fillStyle = on ? COLORS.bone : COLORS.dim;
    ctx.fillText(r.name, x + 8 * k, y + 7 * k, Math.max(20 * k, w - 14 * k));
    if (on) { ctx.fillStyle = COLORS.bone; ctx.beginPath(); ctx.arc(x + w, y + h, handle, 0, Math.PI * 2); ctx.fill(); }
  }
  if (hdrag && hdrag.type === "draw") {
    const x = P.x0 + Math.min(hdrag.x0, hdrag.x1) * u, y = P.y0 + Math.min(hdrag.y0, hdrag.y1) * u;
    ctx.strokeStyle = COLORS.dns; ctx.lineWidth = 1.5 * k; ctx.setLineDash([5 * k, 4 * k]);
    ctx.strokeRect(x, y, Math.abs(hdrag.x1 - hdrag.x0) * u, Math.abs(hdrag.y1 - hdrag.y0) * u); ctx.setLineDash([]);
  }
  // Captions
  ctx.textBaseline = "alphabetic";
  ctx.font = `italic 500 ${11 * k}px 'Schibsted Grotesk', system-ui`; ctx.fillStyle = COLORS.faint; ctx.textAlign = "center";
  ctx.fillText("the internet", P.x0 + P.w * 0.8, P.y0 - 100 * u);
  const trayN = unplaced().length;
  ctx.font = font(500, 11.5 * k); ctx.fillStyle = COLORS.faint;
  if (trayN) {
    const words = placing ? "Not placed yet" : S.houseEdit ? "Not placed yet: drag each one onto the plan" : `Not placed yet (${trayN})`;
    if (NARROW && trayBox) { ctx.textAlign = "center"; ctx.fillText(words, trayBox.x + trayBox.w / 2, trayBox.y - 4 * k); }
    else { ctx.textAlign = "left"; ctx.fillText(words, P.x0, P.y0 + P.h + 28); }
  }
  ctx.textAlign = "center";
  for (const g of otherGroups) { ctx.fillStyle = COLORS.dim; ctx.fillText(`${g.name} (${g.n})`, g.x, g.y - 20); }
  // The device being placed: a pulsing ring so it's easy to spot
  const cur = S.placing && nodes.get(S.placing.queue[S.placing.i]);
  if (cur) {
    const p = reduceMotion ? 0.5 : (Math.sin(performance.now() / 300) + 1) / 2;
    ctx.strokeStyle = `rgba(127,224,180,${0.5 + p * 0.5})`; ctx.lineWidth = 2.5 * k;
    ctx.beginPath(); ctx.arc(cur.x, cur.y, (16 + p * 5) * k, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}

// ---------- placing devices by tapping (works on phones; no dragging needed) ----------
function startPlacing(keys) {
  S.houseEdit = false; selRoom = null; addingFloor = false;
  S.placing = { queue: keys, i: 0, last: null };
  closeDrawer(); renderPanel(); layout(false);
}
function stopPlacing() { S.placing = null; renderPanel(); layout(false); }
function nextPlacing() {
  const p = S.placing; if (!p) return;
  p.i++;
  while (p.i < p.queue.length && !nodes.get(p.queue[p.i])) p.i++;   // gone quiet meanwhile
  if (p.i >= p.queue.length) { const last = p.last; S.placing = null; toast(last ? `All placed. Last one: ${esc(last)}.` : "Done placing."); }
  renderPanel(); layout(false);
}
// app.js calls this on a plain tap; true means "handled, don't open a sheet".
S.onTap = (e) => {
  if (S.view !== "house" || !S.placing) return false;
  const n = nodes.get(S.placing.queue[S.placing.i]); if (!n) { nextPlacing(); return true; }
  const [wx, wy] = toWorld(e.clientX, e.clientY), P = planFrame(), f = curFloor();
  const px = (wx - P.x0) / P.u, py = (wy - P.y0) / P.u;
  if (px < 0 || px > PLAN_W || py < 0 || py > PLAN_H) { toast("Tap inside the plan, or Skip."); return true; }
  S.house.places[placeKey(n)] = { floor: f.id, x: Math.round(px), y: Math.round(py) };
  const room = roomAt(f, px, py);
  S.placing.last = `${nodeLabel(n.key)} in ${room ? room.name : f.name}`;
  saveHouse(); nextPlacing();
  return true;
};
drawerBody.addEventListener("click", (e) => {
  const b = e.target.closest('[data-act="place"]'); if (!b) return;
  startPlacing([b.dataset.key]);
});

// ---------- editing: draw rooms, move them, drag devices ----------
sky.addEventListener("pointerdown", (e) => {
  if (S.view !== "house" || !S.houseEdit) return;
  if (hdrag) { e.stopImmediatePropagation(); return; }   // one finger at a time while editing
  const [wx, wy] = toWorld(e.clientX, e.clientY), P = planFrame(), f = curFloor();
  lastPointer = e.pointerType || "mouse";
  const finger = lastPointer !== "mouse";
  const key = hitTest(e.clientX, e.clientY), n = key && nodes.get(key);
  let claim = null;
  const px = (wx - P.x0) / P.u, py = (wy - P.y0) / P.u;
  const sel = selRoom && f.rooms.find((r) => r.id === selRoom);
  if (sel && Math.hypot(sel.x + sel.w - px, sel.y + sel.h - py) * P.u * view.s < (finger ? 36 : 22)) {
    claim = { type: "resize", r: sel };   // the corner dot wins over anything under it
  } else if (n && placeKey(n)) claim = { type: "node", n, key: placeKey(n) };
  else if (px >= 0 && px <= PLAN_W && py >= 0 && py <= PLAN_H) {
    const pad = finger ? 8 : 4;
    const hit = f.rooms.filter((r) => px >= r.x - pad && px <= r.x + r.w + pad && py >= r.y - pad && py <= r.y + r.h + pad)
      .sort((a, b) => a.w * a.h - b.w * b.h)[0];
    if (hit) {
      claim = { type: "room", r: hit, ox: px - hit.x, oy: py - hit.y };
      if (selRoom !== hit.id) { selRoom = hit.id; renderPanel(); }
    } else {
      claim = { type: "draw", x0: snap10(px), y0: snap10(py), x1: snap10(px), y1: snap10(py) };
      if (selRoom) { selRoom = null; renderPanel(); }
    }
  }
  if (!claim) return;   // outside the plan: pan as usual
  e.stopImmediatePropagation();
  try { sky.setPointerCapture(e.pointerId); } catch { /* synthetic or already gone */ }
  hdrag = { ...claim, id: e.pointerId, moved: false, sx: e.clientX, sy: e.clientY };
}, true);

sky.addEventListener("pointermove", (e) => {
  if (!hdrag) return;
  e.stopImmediatePropagation();
  if (e.pointerId !== hdrag.id) return;
  if (!hdrag.moved && Math.hypot(e.clientX - hdrag.sx, e.clientY - hdrag.sy) < 4) return;
  hdrag.moved = true;
  const [wx, wy] = toWorld(e.clientX, e.clientY), P = planFrame();
  const px = (wx - P.x0) / P.u, py = (wy - P.y0) / P.u;
  if (hdrag.type === "node") { hdrag.n.x = hdrag.n.tx = wx; hdrag.n.y = hdrag.n.ty = wy; }
  if (hdrag.type === "room") {
    const r = hdrag.r;
    r.x = clamp(snap10(px - hdrag.ox), 0, PLAN_W - r.w); r.y = clamp(snap10(py - hdrag.oy), 0, PLAN_H - r.h);
  }
  if (hdrag.type === "resize") {
    const r = hdrag.r;
    r.w = clamp(snap10(px - r.x), 30, PLAN_W - r.x); r.h = clamp(snap10(py - r.y), 30, PLAN_H - r.y);
  }
  if (hdrag.type === "draw") { hdrag.x1 = clamp(snap10(px), 0, PLAN_W); hdrag.y1 = clamp(snap10(py), 0, PLAN_H); }
}, true);

function endHouseDrag(e) {
  if (!hdrag) return;
  e.stopImmediatePropagation();
  if (e.pointerId !== hdrag.id) return;
  const d = hdrag; hdrag = null;
  const f = curFloor(), P = planFrame();
  if (d.type === "node") {
    if (!d.moved) { openDrawer(d.n.key); return; }
    const px = (d.n.x - P.x0) / P.u, py = (d.n.y - P.y0) / P.u;
    if (px >= 0 && px <= PLAN_W && py >= 0 && py <= PLAN_H) S.house.places[d.key] = { floor: f.id, x: Math.round(px), y: Math.round(py) };
    else delete S.house.places[d.key];
    saveHouse(); layout(false);
  } else if (d.type === "draw") {
    const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1), w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
    if (w >= 30 && h >= 30) addRoom("Room", { x, y, w, h });
  } else if (d.moved) saveHouse();
}
sky.addEventListener("pointerup", endHouseDrag, true);
sky.addEventListener("pointercancel", endHouseDrag, true);

// A new room, either drawn or from a one-tap preset (placed in the first free spot).
function freeSpot(f) {
  const clash = (x, y, w, h) => f.rooms.some((r) => x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y);
  for (const [w, h] of [[260, 200], [200, 160], [150, 120], [100, 100]])
    for (let y = 0; y + h <= PLAN_H; y += 20) for (let x = 0; x + w <= PLAN_W; x += 20) if (!clash(x, y, w, h)) return { x, y, w, h };
  return { x: 400, y: 250, w: 200, h: 200 };
}
function addRoom(name, box) {
  const f = curFloor(), b = box || freeSpot(f);
  const same = f.rooms.filter((r) => r.name === name || r.name.startsWith(`${name} `)).length;
  const r = { id: uid(), name: same ? `${name} ${same + 1}` : name, ...b };
  f.rooms.push(r); selRoom = r.id; saveHouse(); renderPanel();
  const inp = $("roomName"); if (inp && !NARROW && name === "Room") { inp.focus(); inp.select(); }
}
function addFloor(name) {
  const fl = S.house.floors;
  if (!fl.length) curFloor();
  const nf = { id: uid(), name: fl.some((x) => x.name === name) ? `${name} 2` : name, rooms: [] };
  const firstNonBasement = fl.findIndex((x) => !/basement|cellar/i.test(x.name));
  if (/basement/i.test(name)) fl.unshift(nf);                                       // under everything
  else if (/main/i.test(name)) fl.splice(firstNonBasement < 0 ? fl.length : firstNonBasement, 0, nf);
  else if (/upstairs/i.test(name)) { const attic = fl.findIndex((x) => /attic/i.test(x.name)); fl.splice(attic < 0 ? fl.length : attic, 0, nf); }
  else fl.push(nf);
  S.floor = nf.id; selRoom = null; addingFloor = false; saveHouse(); layout(false);
}

// ---------- saving ----------
function saveHouse() {
  savePending = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const r = await fetch("api/house", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(S.house) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Not saved.");
    } catch (err) { toast(`Floor plan not saved: ${esc(err.message)}`); }
    finally { savePending = false; }
  }, 500);
}
function setHouse(h) {
  if (hdrag || savePending || !h) return;   // don't yank the plan out from under an edit
  S.house = h;
  if (S.view === "house") { layoutSoon(); renderPanel(); }
}

// ---------- the panel: floors, rooms, placing ----------
function chips(list, attr) { return `<div class="hpChips">${list.map((x) => `<button type="button" ${attr}="${esc(x)}">${esc(x)}</button>`).join("")}</div>`; }
function renderPanel() {
  housePanel.hidden = S.view !== "house";
  if (housePanel.hidden) return;
  const f = curFloor(), r = selRoom && f.rooms.find((x) => x.id === selRoom), left = unplaced().length;
  const tabs = S.house.floors.map((x) => `<button type="button" data-floor="${esc(x.id)}" aria-pressed="${x.id === f.id}">${esc(x.name)}</button>`).join("")
    + (S.house.floors.length < 8 && !S.placing ? `<button type="button" data-h="addFloor" aria-pressed="${addingFloor}">+ Floor</button>` : "");
  let right = `<button type="button" data-h="edit" class="${S.houseEdit ? "primary" : ""}">${S.houseEdit ? "Done" : "Edit plan"}</button>`;
  let body = "";
  if (addingFloor) {
    body = `<p class="hpHint">Which floor?</p>${chips(floorPresets().filter((n) => !S.house.floors.some((x) => x.name === n) || n === "Other floor"), "data-newfloor")}`;
  } else if (S.placing) {
    const p = S.placing, n = nodes.get(p.queue[p.i]);
    right = `<button type="button" data-h="stopPlace">Done</button>`;
    body = `<p class="hpHint">${p.last ? `Placed ${esc(p.last)}. ` : ""}Tap the plan where <b>${esc(n ? nodeLabel(n.key) : "it")}</b> goes${p.queue.length > 1 ? ` (${p.i + 1} of ${p.queue.length})` : ""}. Pick another floor above if it's not on ${esc(f.name)}.</p>
      ${p.queue.length > 1 ? `<div class="hpRow"><button type="button" data-h="skip">Skip this one</button></div>` : ""}`;
  } else if (S.houseEdit) {
    body = r
      ? `<p class="hpHint">Drag the room to move it, or its corner dot to resize it.</p>
         <div class="hpRow"><input id="roomName" value="${esc(r.name)}" maxlength="40" aria-label="Room name"><button type="button" data-h="delRoom">Delete room</button></div>
         ${chips(roomPresets().filter((x) => x !== "Room"), "data-rename")}`
      : `<p class="hpHint">Tap a room to add it, or drag across empty space to draw one.</p>${chips(roomPresets(), "data-addroom")}
         <div class="hpRow"><input id="floorName" value="${esc(f.name)}" maxlength="40" aria-label="Floor name">${S.house.floors.length > 1 ? `<button type="button" data-h="delFloor">${confirmDelFloor ? "Tap again to delete" : "Delete floor"}</button>` : ""}</div>
         ${uploadRows(f)}`;
  } else if (!f.rooms.length) {
    body = `<p class="hpHint">No rooms on ${esc(f.name)} yet. Tap Edit plan to add them.</p>`;
  }
  if (!S.houseEdit && !S.placing && !addingFloor && left) body += `<div class="hpRow"><button type="button" class="primary" data-h="placeAll">Place devices (${left})</button></div>`;
  housePanel.innerHTML = `<div class="hpTop"><div class="floors">${tabs}</div>${right}</div>${body}`;
}
housePanel.addEventListener("click", (e) => {
  const fb = e.target.closest("[data-floor]");
  if (fb) { S.floor = fb.dataset.floor; selRoom = null; confirmDelFloor = false; addingFloor = false; renderPanel(); layout(false); return; }
  const nf = e.target.closest("[data-newfloor]"); if (nf) { addFloor(nf.dataset.newfloor); renderPanel(); return; }
  const ar = e.target.closest("[data-addroom]"); if (ar) { addRoom(ar.dataset.addroom); return; }
  const rn = e.target.closest("[data-rename]");
  if (rn) { const r = curFloor().rooms.find((x) => x.id === selRoom); if (r) { r.name = rn.dataset.rename; saveHouse(); renderPanel(); } return; }
  const b = e.target.closest("[data-h]"); if (!b) return;
  const f = curFloor(), a = b.dataset.h;
  if (a !== "delFloor") confirmDelFloor = false;
  if (a === "edit") { S.houseEdit = !S.houseEdit; selRoom = null; addingFloor = false; if (!S.houseEdit) saveHouse(); }
  if (a === "addFloor") addingFloor = !addingFloor;
  if (a === "placeAll") { startPlacing(unplaced().map((n) => n.key)); return; }
  if (a === "skip") { nextPlacing(); return; }
  if (a === "stopPlace") { stopPlacing(); return; }
  if (a === "delRoom") {
    const i = f.rooms.findIndex((x) => x.id === selRoom);
    if (i >= 0) {
      const [gone] = f.rooms.splice(i, 1); lastDeleted = { floor: f.id, room: gone, i };
      toast(`Deleted ${esc(gone.name)}.`, `<button type="button" data-room-undo>Undo</button>`);
    }
    selRoom = null; saveHouse();
  }
  if (a === "delFloor") {
    if (!confirmDelFloor) confirmDelFloor = true;
    else {
      S.house.floors = S.house.floors.filter((x) => x.id !== f.id);
      for (const [k, p] of Object.entries(S.house.places)) if (p.floor === f.id) delete S.house.places[k];
      S.floor = null; confirmDelFloor = false; saveHouse(); layout(false);
    }
  }
  renderPanel();
});
housePanel.addEventListener("input", (e) => {
  const f = curFloor();
  if (e.target.id === "imgOpacity" && f.image) { f.image.opacity = Number(e.target.value) / 100; saveHouse(); return; }
  if (e.target.id === "roomName") { const r = f.rooms.find((x) => x.id === selRoom); if (r) { r.name = e.target.value.slice(0, 40); saveHouse(); } }
  if (e.target.id === "floorName") {
    f.name = e.target.value.slice(0, 40); saveHouse();
    const tab = housePanel.querySelector(`[data-floor="${CSS.escape(f.id)}"]`); if (tab) tab.textContent = f.name;
  }
});

// ---------- switching views ----------
const VIEWS = [["sky", "Map", "Everything at a glance"], ["house", "Floor plan", "Your rooms, seen from above"], ["holo", "3D", "Your home in 3D, live"]];
function setView(v) {
  if (!VIEWS.some(([id]) => id === v)) v = "sky";
  S.view = v; S.houseEdit = false; selRoom = null; S.placing = null; addingFloor = false;
  document.body.classList.toggle("houseView", v === "house");
  document.body.classList.toggle("holoView", v === "holo");
  if (window.Holo) Holo.setActive(v === "holo");
  viewMenu.hidden = true; houseBtn.setAttribute("aria-expanded", "false");
  try { localStorage.setItem("huginn.view", v); } catch { /* private window */ }
  renderPanel(); fit(); layout(false);   // nodes glide between the sky and the plan
}
// The View button opens a small chooser: Map, Floor plan, 3D.
const viewMenu = document.createElement("div");
viewMenu.className = "viewMenu"; viewMenu.hidden = true; viewMenu.setAttribute("role", "menu");
document.body.append(viewMenu);
function openViewMenu() {
  viewMenu.innerHTML = VIEWS.map(([id, name, sub]) => `<button type="button" role="menuitemradio" aria-checked="${S.view === id}" data-view="${id}"><b>${name}</b><span>${sub}</span></button>`).join("");
  const r = houseBtn.getBoundingClientRect();
  viewMenu.style.left = `${Math.max(8, Math.min(innerWidth - 268, r.left + r.width / 2 - 130))}px`;
  viewMenu.style.bottom = `${innerHeight - r.top + 8}px`;
  viewMenu.hidden = false; houseBtn.setAttribute("aria-expanded", "true");
  viewMenu.querySelector('[aria-checked="true"]').focus({ preventScroll: true });
}
houseBtn.addEventListener("click", (e) => { e.stopPropagation(); if (viewMenu.hidden) openViewMenu(); else { viewMenu.hidden = true; houseBtn.setAttribute("aria-expanded", "false"); } });
viewMenu.addEventListener("click", (e) => { const b = e.target.closest("[data-view]"); if (b) setView(b.dataset.view); });
addEventListener("click", (e) => { if (!viewMenu.hidden && !viewMenu.contains(e.target)) { viewMenu.hidden = true; houseBtn.setAttribute("aria-expanded", "false"); } });
addEventListener("keydown", (e) => { if (e.key === "Escape" && !viewMenu.hidden) { viewMenu.hidden = true; houseBtn.focus(); } });
try { const v = localStorage.getItem("huginn.view"); if (v && v !== "sky") setTimeout(() => setView(v), 50); } catch { /* fine */ }

// ---------- your own floor plan picture, or a 3D scan of the house ----------
const pictures = new Map();
function planPicture(file) {
  let im = pictures.get(file);
  if (!im) { im = new Image(); im.src = `api/house/asset/${file}`; pictures.set(file, im); }
  return im;
}
let uploading = null;   // { what, note }
function uploadRows(f) {
  const busy = uploading ? `<p class="hpHint" role="status">${esc(uploading.note)}</p>` : "";
  const pic = f.image
    ? `<div class="hpRow hpUp"><span>Floor plan picture</span><input id="imgOpacity" type="range" min="10" max="100" value="${Math.round(f.image.opacity * 100)}" aria-label="How strongly the picture shows"><button type="button" data-h="rmImage">Remove</button></div>`
    : `<div class="hpRow"><label class="fileBtn">Add a floor plan picture<input type="file" accept="image/png,image/jpeg,image/webp" data-up="image"></label></div>`;
  const scan = f.model
    ? `<div class="hpRow hpUp"><span>3D scan added. Line it up in the 3D view.</span><button type="button" data-h="rmModel">Remove</button></div>`
    : `<div class="hpRow"><label class="fileBtn">Add a 3D scan (.glb)<input type="file" accept=".glb,model/gltf-binary" data-up="model"></label></div>`;
  return busy + pic + scan;
}
housePanel.addEventListener("change", async (e) => {
  const inp = e.target.closest("[data-up]"); if (!inp || !inp.files || !inp.files[0]) return;
  const file = inp.files[0], what = inp.dataset.up, f = curFloor();
  const mb = (file.size / 1048576).toFixed(1);
  uploading = { what, note: `Uploading ${file.name} (${mb} MB)...` }; renderPanel();
  try {
    const r = await fetch("api/house/asset", { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Not uploaded.");
    if (what === "image") {
      if (j.kind === "glb") throw new Error("That's a 3D model. Use Add a 3D scan for it.");
      f.image = { file: j.file, opacity: 0.6 };
      toast("Picture added. Draw your rooms over it.");
    } else {
      if (j.kind !== "glb") throw new Error("That's a picture. Use Add a floor plan picture for it.");
      f.model = { file: j.file, scale: 1, rot: 0, x: 500, y: 350, lift: 0, look: "holo" };
      toast("3D scan added. Open View, 3D to see it and line it up.");
    }
    saveHouse();
  } catch (err) { toast(`Upload failed: ${esc(err.message)}`); }
  uploading = null; renderPanel(); layout(false);
});
housePanel.addEventListener("click", (e) => {
  const b = e.target.closest('[data-h="rmImage"], [data-h="rmModel"]'); if (!b) return;
  const f = curFloor();
  if (b.dataset.h === "rmImage") delete f.image; else delete f.model;
  saveHouse(); renderPanel();
}, true);
