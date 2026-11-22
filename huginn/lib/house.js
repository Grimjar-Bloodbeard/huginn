// The floor plan: floors, rooms drawn on a 1000 x 700 grid, and where each device sits.
// Pure, so it can be tested. The server stores whatever passes checkHouse().
"use strict";

const PLAN_W = 1000, PLAN_H = 700;
const ID = /^[a-z0-9-]{1,24}$/;
const MAC = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const IPKEY = /^ip:\d{1,3}(\.\d{1,3}){3}$/;

function clean(s, max = 40) { return String(s ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, max); }
// Uploaded pictures and 3D models: random names Huginn picks, checked by their first bytes, not their name.
const ASSET = /^[a-z0-9]{12}.(png|jpg|webp|glb)$/;
const ASSET_TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", glb: "model/gltf-binary" };
function sniffAsset(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG") return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (buf.toString("latin1", 0, 4) === "glTF" && buf.readUInt32LE(4) === 2) return "glb";
  return null;
}
function numf(v, lo, hi, dflt) { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; }
function checkImage(im) {
  if (!im || !ASSET.test(String(im.file)) || /.glb$/.test(im.file)) return null;
  return { file: im.file, opacity: numf(im.opacity, 0.1, 1, 0.6) };
}
function checkModel(m) {
  if (!m || !ASSET.test(String(m.file)) || !/.glb$/.test(m.file)) return null;
  return { file: m.file, scale: numf(m.scale, 0.05, 20, 1), rot: numf(m.rot, -360, 360, 0), x: numf(m.x, -500, 1500, 500),
           y: numf(m.y, -500, 1200, 350), lift: numf(m.lift, -20, 20, 0), look: m.look === "real" ? "real" : "holo" };
}

function num(v, lo, hi) { const n = Number(v); if (!Number.isFinite(n)) return null; return Math.round(Math.min(hi, Math.max(lo, n))); }

function emptyHouse() { return { floors: [], places: {} }; }

// Returns { ok: true, house } or { ok: false, error }.
function checkHouse(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.floors)) return { ok: false, error: "That isn't a floor plan." };
  if (body.floors.length > 8) return { ok: false, error: "Eight floors at most." };
  const floorIds = new Set(), floors = [];
  for (const f of body.floors) {
    if (!f || !ID.test(String(f.id)) || floorIds.has(f.id)) return { ok: false, error: "A floor has a bad or repeated id." };
    floorIds.add(f.id);
    const rooms = [], roomIds = new Set();
    if (!Array.isArray(f.rooms || [])) return { ok: false, error: "Rooms must be a list." };
    if ((f.rooms || []).length > 60) return { ok: false, error: "Sixty rooms per floor at most." };
    for (const r of f.rooms || []) {
      if (!r || !ID.test(String(r.id)) || roomIds.has(r.id)) return { ok: false, error: "A room has a bad or repeated id." };
      roomIds.add(r.id);
      const x = num(r.x, 0, PLAN_W), y = num(r.y, 0, PLAN_H), w = num(r.w, 20, PLAN_W), h = num(r.h, 20, PLAN_H);
      if ([x, y, w, h].includes(null)) return { ok: false, error: "A room has a bad size." };
      rooms.push({ id: r.id, name: clean(r.name) || "Room", x, y, w: Math.min(w, PLAN_W - x), h: Math.min(h, PLAN_H - y) });
    }
    const fl = { id: f.id, name: clean(f.name) || "Floor", rooms };
    const im = checkImage(f.image), md = checkModel(f.model);
    if (im) fl.image = im;
    if (md) fl.model = md;
    floors.push(fl);
  }
  const places = {};
  const src = body.places && typeof body.places === "object" ? body.places : {};
  const keys = Object.keys(src);
  if (keys.length > 400) return { ok: false, error: "Too many placed devices." };
  for (const key of keys) {
    const k = MAC.test(String(key).toUpperCase()) ? String(key).toUpperCase() : String(key);
    if (!(MAC.test(k) || k === "router" || k === "pc" || IPKEY.test(k))) return { ok: false, error: "A placed device has a bad key." };
    const p = src[key];
    if (!p || !floorIds.has(p.floor)) continue;   // its floor was deleted: it goes back to the tray
    const x = num(p.x, 0, PLAN_W), y = num(p.y, 0, PLAN_H);
    if (x == null || y == null) return { ok: false, error: "A placed device has a bad position." };
    places[k] = { floor: p.floor, x, y };
  }
  const house = { floors, places };
  if (body.spread != null) house.spread = numf(body.spread, 1, 3, 1);
  return { ok: true, house };
}

// Every uploaded file the plan still points at.
function assetsInUse(house) {
  const out = new Set();
  for (const f of house.floors || []) { if (f.image) out.add(f.image.file); if (f.model) out.add(f.model.file); }
  return out;
}

module.exports = { PLAN_W, PLAN_H, checkHouse, emptyHouse, sniffAsset, assetsInUse, ASSET, ASSET_TYPES };
