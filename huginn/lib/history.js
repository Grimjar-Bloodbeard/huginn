// Huginn's memory: who talked to whom, second by second, for the last week.
// Only who, when, how much and the site name are kept, never packet contents.
// One file per hour, so a replay reads a few MB rather than a whole day. The current hour is
// plain JSON lines; finished hours are gzipped. Hours older than `keepDays` are deleted.
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const MAX_PAIRS = 40;        // busiest paths kept per second; the rest are only counted
const MAX_SPAN = 15 * 60;    // a single read covers at most 15 minutes
const SLOT_FILE = /^(\d{4}-\d{2}-\d{2}-\d{2})\.jsonl(\.gz)?$/;

function slotOf(sec) {
  const d = new Date(sec * 1000), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}`;
}

class History {
  constructor(dir, { keepDays = 7, now = () => Date.now() / 1000 } = {}) {
    this.dir = dir; this.keepDays = keepDays; this.now = now;
    this.bucket = new Map();   // second -> Map(key -> [s, d, k, bytes, count])
    this.names = new Map();    // ip -> [name, org]
    this.named = new Set();    // ips already named in the current hour's file
    this.namedSlot = null;
    fs.mkdirSync(dir, { recursive: true });
  }

  // sparks: [{ t, s, d, k, b }]
  add(sparks) {
    for (const sp of sparks) {
      if (!sp || !sp.s || !sp.d || !sp.k) continue;
      const sec = Math.floor(sp.t || this.now());
      let m = this.bucket.get(sec);
      if (!m) { m = new Map(); this.bucket.set(sec, m); }
      const key = `${sp.s}|${sp.d}|${sp.k}`;
      const e = m.get(key);
      if (e) { e[3] += sp.b || 0; e[4] += 1; } else m.set(key, [sp.s, sp.d, sp.k, sp.b || 0, 1]);
    }
  }

  // What internet addresses were called, so a replay a week later still shows names.
  learn(hosts) {
    if (this.names.size > 20000) this.names.clear();
    for (const h of hosts) if (h.ip && (h.name || h.org)) this.names.set(h.ip, [h.name || null, h.org || null]);
  }

  // Writes every finished second (older than `lagSec`) to disk.
  flush(lagSec = 2) {
    const cut = Math.floor(this.now()) - lagSec;
    const lines = new Map(); // hour -> [line]
    for (const sec of [...this.bucket.keys()].sort((a, b) => a - b)) {
      if (sec > cut) continue;
      const m = this.bucket.get(sec); this.bucket.delete(sec);
      const all = [...m.values()].sort((a, b) => b[3] - a[3]);
      const kept = all.slice(0, MAX_PAIRS);
      const slot = slotOf(sec);
      if (this.namedSlot !== slot) { this.namedSlot = slot; this.named.clear(); }
      const nm = {};
      for (const f of kept) for (const k of [f[0], f[1]]) {
        if (!k.startsWith("net:")) continue;
        const ip = k.slice(4);
        if (!this.named.has(ip) && this.names.has(ip)) { nm[ip] = this.names.get(ip); this.named.add(ip); }
      }
      const rec = { t: sec, f: kept };
      if (all.length > kept.length) rec.more = all.length - kept.length;
      if (Object.keys(nm).length) rec.n = nm;
      if (!lines.has(slot)) lines.set(slot, []);
      lines.get(slot).push(JSON.stringify(rec));
    }
    for (const [slot, ls] of lines) fs.appendFileSync(path.join(this.dir, `${slot}.jsonl`), ls.join("\n") + "\n");
  }

  // Gzips finished hours and deletes hours older than keepDays.
  tidy() {
    const current = slotOf(this.now());
    const oldest = slotOf(this.now() - this.keepDays * 86400);
    for (const f of fs.readdirSync(this.dir)) {
      const m = SLOT_FILE.exec(f);
      if (!m) continue;
      const p = path.join(this.dir, f);
      if (m[1] < oldest) { fs.unlinkSync(p); continue; }
      if (!m[2] && m[1] < current) {
        fs.writeFileSync(`${p}.gz`, zlib.gzipSync(fs.readFileSync(p)));
        fs.unlinkSync(p);
      }
    }
  }

  readSlot(slot) {
    const p = path.join(this.dir, `${slot}.jsonl`);
    try { return fs.readFileSync(p, "utf8"); } catch { /* maybe gzipped */ }
    try { return zlib.gunzipSync(fs.readFileSync(`${p}.gz`)).toString("utf8"); } catch { return ""; }
  }

  // Seconds in [from, until), plus every name written in those hours.
  read(from, until) {
    from = Math.floor(from); until = Math.floor(until);
    if (!(until > from)) return { from, until, seconds: [], names: {} };
    if (until - from > MAX_SPAN) until = from + MAX_SPAN;
    const slots = [...new Set([slotOf(from), slotOf(until - 1)])];
    const seconds = [], names = {};
    for (const slot of slots) {
      for (const line of this.readSlot(slot).split("\n")) {
        if (!line) continue;
        let rec; try { rec = JSON.parse(line); } catch { continue; }
        if (rec.n) Object.assign(names, rec.n);
        if (rec.t >= from && rec.t < until) seconds.push(rec);
      }
    }
    seconds.sort((a, b) => a.t - b.t);
    return { from, until, seconds, names };
  }

  // The earliest second on disk, so the page knows how far back it can go.
  oldest() {
    const slots = fs.readdirSync(this.dir).map((f) => SLOT_FILE.exec(f)).filter(Boolean).map((m) => m[1]).sort();
    if (!slots.length) return null;
    const first = this.readSlot(slots[0]).split("\n", 1)[0];
    try { return JSON.parse(first).t; } catch { return null; }
  }
}

module.exports = { History, slotOf, MAX_PAIRS, MAX_SPAN };
