// Unusual: what's normal for each device, learned from its Pi-hole lookups, and what isn't.
// Two baselines: each device's own, and the whole house's. The first 7 days only log (learning),
// and nothing becomes "normal" unless you tap it. Pure apart from the clock, so it can be tested.
"use strict";

const BURN_IN = 7 * 86400;          // log quietly for the first week
const WINDOW = 300;                  // bursts are judged per 5 minutes
const MAX_SITES = 5000, MAX_FINDINGS = 500;
const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "gob"]);
const BROWSERS = new Set(["phone", "tablet", "computer", "laptop"]);

// "api.ps5.playstation.net" -> "playstation.net"; local names and reverse lookups -> null.
function site(domain) {
  const d = String(domain || "").toLowerCase().replace(/\.$/, "");
  if (!d.includes(".") || /\.(local|lan|home|arpa|internal|localdomain|home\.arpa)$/.test(d) || /^[\d.:]+$/.test(d)) return null;
  const p = d.split(".");
  if (p.length >= 3 && p[p.length - 1].length === 2 && SECOND_LEVEL.has(p[p.length - 2])) return p.slice(-3).join(".");
  return p.slice(-2).join(".");
}
function hourOf(t) { return new Date(t * 1000).getHours(); }
function dayOf(t) { const d = new Date(t * 1000); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }

function emptyData() { return { started: null, lastId: 0, devices: {}, house: {}, normal: {}, findings: [], seq: 0 }; }

class Baseline {
  // kindOf(id) -> the device's icon, so phones and computers (which meet new sites all day) aren't nagged about it.
  constructor({ data, now = () => Date.now() / 1000, kindOf = () => null } = {}) {
    this.d = Object.assign(emptyData(), data || {});
    this.now = now; this.kindOf = kindOf; this.dirty = false;
  }

  learning(t = this.now()) { return !this.d.started || t - this.d.started < BURN_IN; }

  dev(id, t) {
    let v = this.d.devices[id];
    if (!v) v = this.d.devices[id] = { first: t, sites: {}, hours: Array(24).fill(0), total: 0, fresh: [], win: null, n: 0, blk: 0, ema: 0, emaB: 0, okHours: [], oddDay: {} };
    return v;
  }

  // One lookup: { t, id (device key), ip, domain, blocked }. Returns any new finding.
  observe(l) {
    const s = site(l.domain); if (!s || !l.id) return [];
    const t = l.t, v = this.dev(l.id, t), out = [];
    if (!this.d.started) this.d.started = t;
    v.ip = l.ip; if (t > (this.d.lastT || 0)) this.d.lastT = t;
    this.dirty = true;
    out.push(...this.closeWindow(l.id, v, t));
    v.n++; if (l.blocked) v.blk++;

    // Odd hour: the device is busy at an hour it almost never is (judged after 3 days of history).
    const h = hourOf(t);
    if (t - v.first > 3 * 86400 && v.total > 500 && v.hours[h] / v.total < 0.004 && !v.okHours.includes(h)) {
      const key = `${dayOf(t)}-${h}`;
      if (!v.oddDay[key]) {
        v.oddDay = { [key]: 1 };
        out.push(this.find({ t, id: l.id, ip: l.ip, kind: "odd-hour", hour: h,
          title: `Busy at ${h === 0 ? 12 : h > 12 ? h - 12 : h} ${h < 12 ? "AM" : "PM"}, an hour it's almost never active`,
          detail: `First website it asked for this hour: ${l.domain}` }));
      }
    }
    v.hours[h]++; v.total++;

    // New site, for this device and maybe for the whole house.
    const had = v.sites[s], houseHad = this.d.house[s];
    if (had) { had[1] = t; had[2]++; }
    else {
      v.sites[s] = [t, t, 1];
      v.fresh.push(t); if (v.fresh.length > 60) v.fresh.shift();
      const recentNew = v.fresh.filter((x) => x > t - 86400).length;
      const browser = BROWSERS.has(this.kindOf(l.id)) || recentNew > 12;
      const settled = t - v.first > 86400;
      if (settled && !browser && !this.isNormal(l.id, s)) {
        const open = this.d.findings.find((f) => f.id === l.id && f.kind === "new-site" && !f.done && t - f.t < 600);
        if (open && open.sites.length < 12) { open.sites.push(s); open.houseNew = open.houseNew || !houseHad; open.title = newSiteTitle(open); }
        else {
          const f = this.find({ t, id: l.id, ip: l.ip, kind: "new-site", sites: [s], houseNew: !houseHad, detail: l.domain });
          f.title = newSiteTitle(f); out.push(f);
        }
      }
      if (Object.keys(v.sites).length > MAX_SITES) {
        const old = Object.entries(v.sites).sort((a, b) => a[1][1] - b[1][1]).slice(0, 500);
        for (const [k] of old) delete v.sites[k];
      }
    }
    if (houseHad) { houseHad[1] = t; houseHad[2]++; } else this.d.house[s] = [t, t, 1];
    return out;
  }

  // Ends a 5-minute window and checks it for bursts against the device's usual window.
  closeWindow(id, v, t) {
    const w = Math.floor(t / WINDOW), out = [];
    if (v.win === w) return out;
    if (v.win != null && v.n) {
      const at = (v.win + 1) * WINDOW;
      if (v.blk >= 40 && v.blk > 6 * v.emaB + 10 && v.blk > (v.okBlk || 0)) {
        out.push(this.find({ t: at, id, ip: v.ip, kind: "blocked-burst", count: v.blk,
          title: `${v.blk} blocked website requests in 5 minutes`, detail: `It usually has about ${Math.round(v.emaB)}. Adware, a broken app, or something phoning home.` }));
      } else if (v.n >= 300 && v.n > 6 * v.ema + 50 && v.n > (v.okN || 0)) {
        out.push(this.find({ t: at, id, ip: v.ip, kind: "burst", count: v.n,
          title: `${v.n} website requests in 5 minutes`, detail: `It usually makes about ${Math.round(v.ema)}.` }));
      }
      // Quiet windows in between count as zero, so a device that's usually idle has a low "usual".
      const gap = Math.min(50, w - v.win - 1);
      for (let i = 0; i < gap; i++) { v.ema *= 0.97; v.emaB *= 0.97; }
      v.ema = v.ema * 0.97 + v.n * 0.03; v.emaB = v.emaB * 0.97 + v.blk * 0.03;
    }
    v.win = w; v.n = 0; v.blk = 0;
    return out;
  }

  // Closes windows of devices that went quiet, so their last burst is still judged.
  tick(t = this.now()) {
    const out = [];
    for (const [id, v] of Object.entries(this.d.devices)) if (v.win != null && v.win < Math.floor(t / WINDOW) - 1) out.push(...this.closeWindow(id, v, t));
    return out;
  }

  find(f) {
    const full = { ...f, fid: `${Math.floor(f.t)}-${(++this.d.seq).toString(36)}`, quiet: this.learning(f.t), seen: false, done: null };
    this.d.findings.push(full);
    if (this.d.findings.length > MAX_FINDINGS) this.d.findings.splice(0, this.d.findings.length - MAX_FINDINGS);
    this.dirty = true;
    return full;
  }

  isNormal(id, s) { return !!(this.d.normal[`${id}|${s}`] || this.d.normal[`*|${s}`]); }

  // Your tap: teach Huginn this is fine, for this device or (for sites) the whole house.
  markNormal(fid, scope = "device", t = this.now()) {
    const f = this.d.findings.find((x) => x.fid === fid);
    if (!f) return { ok: false, error: "That finding is gone." };
    const v = this.d.devices[f.id];
    if (f.kind === "new-site") for (const s of f.sites) this.d.normal[`${scope === "house" ? "*" : f.id}|${s}`] = Math.floor(t);
    if (f.kind === "odd-hour" && v && !v.okHours.includes(f.hour)) v.okHours.push(f.hour);
    if (f.kind === "burst" && v) v.okN = Math.ceil(f.count * 1.5);
    if (f.kind === "blocked-burst" && v) v.okBlk = Math.ceil(f.count * 1.5);
    f.done = "normal"; f.seen = true; this.dirty = true;
    return { ok: true };
  }
  markSeen(fid) {
    for (const f of this.d.findings) if (fid === "all" ? !f.seen : f.fid === fid) f.seen = true;
    this.dirty = true;
    return { ok: true };
  }

  view(limit = 120) {
    return { started: this.d.started, learnUntil: this.d.started ? this.d.started + BURN_IN : null,
             findings: this.d.findings.slice(-limit) };
  }
}

function newSiteTitle(f) {
  const n = f.sites.length, what = n === 1 ? `a new site, ${f.sites[0]}` : `${n} new sites`;
  return f.houseNew ? `Reached ${what} nothing in the house has used before` : `Reached ${what} (new for this device, known in the house)`;
}

module.exports = { Baseline, site, emptyData, BURN_IN };
