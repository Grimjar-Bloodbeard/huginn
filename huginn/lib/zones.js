// Zones: sort devices into Trusted, Things, Guests and Quarantine.
// Today a zone is a Pi-hole group (DNS only: names and blocklists, not a wall between devices).
// Every move is previewed in plain words first, written to the change journal, and can be undone.
"use strict";

const ZONES = [
  { id: "trusted", name: "Trusted", color: "#7FE0B4",
    rule: "Your own computers and phones. Normal ad blocking." },
  { id: "things", name: "Things", color: "#86D6FF",
    rule: "TVs, consoles, speakers and plugs. Normal ad blocking. They have no reason to talk to your computers." },
  { id: "guests", name: "Guests", color: "#FFB45C",
    rule: "Visitors. Normal ad blocking. For a real wall, they join the guest Wi-Fi." },
  { id: "quarantine", name: "Quarantine", color: "#FF5D73",
    rule: "Something you don't trust right now. The ad blocker refuses every website it asks for, so most of its apps go dark." },
];
const BY_ID = new Map(ZONES.map((z) => [z.id, z]));
const MAC = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const COMMENT = "Huginn zone";

function groupName(zone) { return `Huginn-${BY_ID.get(zone).name}`; }
function zoneName(zone) { return zone ? BY_ID.get(zone).name : "No zone"; }

// A first guess from the device's icon, for "Sort for me". Never applied without a tap.
const SUGGEST = { phone: "trusted", tablet: "trusted", computer: "trusted", laptop: "trusted", watch: "trusted", server: "trusted", router: "trusted",
                  tv: "things", console: "things", speaker: "things", camera: "things", plug: "things", chip: "things", printer: "things" };
function suggestZone(d = {}) {
  if (d.role === "guest") return "guests";
  return SUGGEST[d.icon] || null;
}

// { moves: [{ mac, zone }] } -> { ok, moves } (zone null means "take it out of its zone").
function checkMoves(body) {
  const list = body && Array.isArray(body.moves) ? body.moves : null;
  if (!list || !list.length) return { ok: false, error: "No devices to move." };
  if (list.length > 50) return { ok: false, error: "Fifty devices at a time at most." };
  const seen = new Set(), moves = [];
  for (const m of list) {
    const mac = String((m && m.mac) || "").toUpperCase();
    if (!MAC.test(mac)) return { ok: false, error: "Zones need a device's hardware address." };
    if (seen.has(mac)) return { ok: false, error: "A device is listed twice." };
    const zone = m.zone == null || m.zone === "none" ? null : String(m.zone);
    if (zone && !BY_ID.has(zone)) return { ok: false, error: "Unknown zone." };
    seen.add(mac); moves.push({ mac, zone });
  }
  return { ok: true, moves };
}

// data/zones.json: { members: { MAC: { zone, t } }, journal: [ entries, newest last ] }
function checkZonesFile(obj) {
  const out = { members: {}, journal: [] };
  const src = obj && obj.members && typeof obj.members === "object" ? obj.members : {};
  for (const [k, v] of Object.entries(src)) {
    const mac = k.toUpperCase();
    if (MAC.test(mac) && v && BY_ID.has(v.zone)) out.members[mac] = { zone: v.zone, t: Number(v.t) || 0 };
  }
  if (obj && Array.isArray(obj.journal)) out.journal = obj.journal.filter((e) => e && e.id && Array.isArray(e.items)).slice(-200);
  return out;
}

function groupsFor(zone, ids) { return zone === "quarantine" ? [ids.quarantine] : [0, ids[zone]]; }
function isOurs(entry) { return !!entry && String(entry.comment || "").startsWith(COMMENT); }

// What a set of moves would do, in plain words. Reads Pi-hole, changes nothing.
async function planMoves(admin, moves, data, names = {}) {
  const groups = await admin.groups(), have = new Set(groups.map((g) => g.name));
  const items = [], once = [];
  const needs = new Set(moves.map((m) => m.zone).filter(Boolean));
  for (const z of needs) if (!have.has(groupName(z))) once.push(`Make a group called ${groupName(z)} in your ad blocker (Pi-hole). This happens once; it starts empty.`);
  if (needs.has("quarantine") && !(await admin.quarantineRule())) {
    once.push("Add one ad-blocker rule that refuses every website, for the Huginn-Quarantine group only. Nothing else in the house is affected.");
  }
  for (const { mac, zone } of moves) {
    const name = names[mac] || mac, from = (data.members[mac] || {}).zone || null;
    const entry = await admin.client(mac), steps = [];
    if (from === zone) { items.push({ mac, name, from, to: zone, steps: ["Already there. Nothing to change."], same: true }); continue; }
    if (zone === "quarantine") steps.push(`Put ${name} in the Huginn-Quarantine group only. The ad blocker stops answering it, so it can't reach websites.`);
    else if (zone) steps.push(`Put ${name} in the ${groupName(zone)} group (plus the usual Default group). Ad blocking stays as it is today.`);
    else if (isOurs(entry)) steps.push(`Take ${name} out of Huginn's groups, so it is treated like any other device again.`);
    else steps.push("Nothing in the ad blocker needs to change.");
    if (entry && !isOurs(entry)) steps.push(`The ad blocker already had a setting for it (groups ${entry.groups.join(", ") || "none"}). Undo puts that back.`);
    items.push({ mac, name, from, to: zone, steps });
  }
  return { once, items };
}

let seq = 0;
function newId(now) { return `${Math.floor(now)}-${(++seq).toString(36)}`; }

// Does the moves, one device at a time, and returns a journal entry. If one fails, the ones
// already done stay done and are listed in the entry, so Undo still covers them.
async function applyMoves(admin, moves, data, names = {}, now = Date.now() / 1000) {
  const ids = {};
  for (const z of new Set(moves.map((m) => m.zone).filter(Boolean))) ids[z] = await admin.ensureGroup(groupName(z), `Made by Huginn for the ${zoneName(z)} zone`);
  if (ids.quarantine != null) await admin.ensureQuarantineRule(ids.quarantine);
  const entry = { id: newId(now), t: Math.floor(now), items: [], undone: false, error: null };
  for (const { mac, zone } of moves) {
    const name = names[mac] || mac, from = (data.members[mac] || {}).zone || null;
    if (from === zone) continue;
    try {
      const before = await admin.client(mac);
      if (zone) await admin.putClient(before, mac, groupsFor(zone, ids), `${COMMENT}: ${zoneName(zone)} (${String(name).slice(0, 60)})`);
      else if (isOurs(before)) await admin.deleteClient(before);
      entry.items.push({ mac, name, from, to: zone, before });
      if (zone) data.members[mac] = { zone, t: Math.floor(now) }; else delete data.members[mac];
    } catch (e) { entry.error = `${name}: ${e.message}`; break; }
  }
  if (entry.items.length) { data.journal.push(entry); data.journal = data.journal.slice(-200); }
  return entry;
}

// Puts each device's Pi-hole entry back exactly as it was before the change.
async function undoEntry(admin, id, data, now = Date.now() / 1000) {
  const entry = data.journal.find((e) => e.id === id);
  if (!entry) return { ok: false, error: "That change isn't in the journal." };
  if (entry.undone) return { ok: false, error: "Already undone." };
  const later = data.journal.filter((e) => e.t >= entry.t && e !== entry && !e.undone && data.journal.indexOf(e) > data.journal.indexOf(entry));
  for (const it of entry.items) {
    const l = later.find((e) => e.items.some((x) => x.mac === it.mac));
    if (l) return { ok: false, error: `${it.name} was moved again later. Undo that change first.` };
  }
  for (const it of [...entry.items].reverse()) {
    const cur = await admin.client(it.mac);
    if (it.before) await admin.putClient(cur, it.mac, it.before.groups, it.before.comment);
    else if (cur) await admin.deleteClient(cur);
    if (it.from) data.members[it.mac] = { zone: it.from, t: Math.floor(now) }; else delete data.members[it.mac];
  }
  entry.undone = Math.floor(now);
  return { ok: true, entry };
}

module.exports = { ZONES, groupName, zoneName, suggestZone, checkMoves, checkZonesFile, planMoves, applyMoves, undoEntry, COMMENT };
