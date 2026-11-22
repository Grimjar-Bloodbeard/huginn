// Turns a stream of packets into what the command center draws: hosts this PC
// talks to, devices heard on the LAN, per-second history, and sparks to animate.
// Pure (no I/O), so it can be tested with fake packets.

const { orgOf } = require("./orgs");
const { isPrivate, isCast, portName } = require("./netclass");

const HISTORY_SECONDS = 3600;

class Flows {
  constructor({ localIps = [], gateway = null, dnsServers = [] } = {}) {
    this.local = new Set(localIps);
    this.gateway = gateway;
    this.dnsServers = new Set(dnsServers.concat(gateway ? [gateway] : []));
    this.names = new Map();        // ip -> { name, via: "dns" | "sni" }
    this.hosts = new Map();        // internet ip -> stats
    this.lan = new Map();          // lan ip -> stats
    this.devLookups = new Map();   // device ip -> what it looked up (from Pi-hole)
    this.portProc = new Map();     // "proto:localPort" -> program name
    this.series = [];              // { t, in, out, pkts, top: [[label, bytes]] }
    this.sec = this._newSec(0);
    this.sparks = [];
    this.total = { pkts: 0, bytes: 0, since: null };
  }

  _newSec(t) { return { t, in: 0, out: 0, pkts: 0, by: new Map() }; }

  setLocalIps(ips) { for (const ip of ips) this.local.add(ip); }

  // From netstat: which program owns which local port.
  setPorts(map) { this.portProc = map; }

  learnName(ip, name, via) {
    if (!ip || !name) return;
    const had = this.names.get(ip);
    // The server name the app asked for beats a lookup answer, which beats a reverse lookup.
    const rank = { sni: 3, dns: 2, ptr: 1 };
    if (had && rank[had.via] > rank[via]) return;
    this.names.set(ip, { name, via });
    const h = this.hosts.get(ip);
    if (h) { h.name = name; h.org = orgOf(name); }
  }

  label(ip) {
    const n = this.names.get(ip);
    return n ? n.name : ip;
  }

  ingest([t, src, dst, proto, sport, dport, len]) {
    if (this.total.since == null) this.total.since = t;
    this.total.pkts++; this.total.bytes += len;
    const sec = Math.floor(t);
    if (sec !== this.sec.t) this.roll(sec);

    const fromMe = this.local.has(src), toMe = this.local.has(dst);
    let kind, s, d, remote, localPort, remotePort;

    if (fromMe || toMe) {
      remote = fromMe ? dst : src;
      localPort = fromMe ? sport : dport;
      remotePort = fromMe ? dport : sport;
      const dir = fromMe ? "out" : "in";
      this.sec[dir] += len;
      if (isCast(remote)) {
        kind = "cast"; s = fromMe ? "pc" : "cast"; d = fromMe ? "cast" : "pc";
      } else if (isPrivate(remote)) {
        const isDns = remotePort === 53 && this.dnsServers.has(remote);
        kind = isDns ? "dns" : "lan";
        const node = remote === this.gateway ? "router" : `lan:${remote}`;
        s = fromMe ? "pc" : node; d = fromMe ? node : "pc";
        this._lanHit(remote, len, t, dir, remotePort, proto, localPort);
      } else {
        kind = remotePort === 53 ? "dns" : dir;
        s = fromMe ? "pc" : `net:${remote}`; d = fromMe ? `net:${remote}` : "pc";
        this._hostHit(remote, len, t, dir, remotePort, proto, this.portProc.get(`${proto}:${localPort}`));
      }
    } else {
      // Another device's packet that reached this PC: broadcast or multicast chatter.
      kind = "chatter";
      s = src === this.gateway ? "router" : `lan:${src}`;
      d = "cast";
      if (isPrivate(src)) this._lanHit(src, len, t, "chatter", dport, proto);
    }

    this.sec.pkts++;
    const key = kind === "in" || kind === "out" || kind === "dns" ? remote : null;
    if (key) this.sec.by.set(key, (this.sec.by.get(key) || 0) + len);

    this.sparks.push({ s, d, b: len, k: kind, t, p: proto, rp: remotePort || dport,
                       prog: localPort ? this.portProc.get(`${proto}:${localPort}`) || null : null });
    if (this.sparks.length > 5000) this.sparks.splice(0, this.sparks.length - 5000);
  }

  _hostHit(ip, len, t, dir, port, proto, prog) {
    let h = this.hosts.get(ip);
    if (!h) {
      const n = this.names.get(ip);
      h = { ip, name: n ? n.name : null, org: n ? orgOf(n.name) : null, in: 0, out: 0, pkts: 0,
            first: t, last: t, ports: {}, progs: {} };
      this.hosts.set(ip, h);
    }
    h[dir] += len; h.pkts++; h.last = t;
    const pn = `${port}/${proto}`;
    h.ports[pn] = (h.ports[pn] || 0) + len;
    if (prog) h.progs[prog] = (h.progs[prog] || 0) + len;
  }

  _lanHit(ip, len, t, dir, port, proto, localPort) {
    let l = this.lan.get(ip);
    if (!l) { l = { ip, in: 0, out: 0, chatter: 0, pkts: 0, first: t, last: t, ports: {} }; this.lan.set(ip, l); }
    if (dir === "chatter") l.chatter += len; else l[dir] += len;
    l.pkts++; l.last = t;
    const name = portName(port, proto) || `${port}/${proto}`;
    l.ports[name] = (l.ports[name] || 0) + len;
    // The device started it (its port is the higher, temporary one): it reached into this PC,
    // rather than answering this PC's own question (discovery, casting, Remote Play).
    if (dir === "in" && localPort && localPort < 49152 && port > localPort && port > 1023) {   // 49152+ is temporary on both ends
      l.opened = (l.opened || 0) + len; l.openedLast = t;
      l.openedPorts = l.openedPorts || {};
      const mine = portName(localPort, proto) || `${localPort}/${proto}`;
      l.openedPorts[mine] = (l.openedPorts[mine] || 0) + len;
    }
  }

  roll(nextSec) {
    const s = this.sec;
    if (s.t) {
      const top = [...s.by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([ip, b]) => [this.label(ip), b]);
      this.series.push({ t: s.t, in: s.in, out: s.out, pkts: s.pkts, top });
      if (this.series.length > HISTORY_SECONDS) this.series.shift();
    }
    this.sec = this._newSec(nextSec);
  }

  // Up to `max` sparks since the last call, spread evenly so bursts still look like bursts.
  drainSparks(max = 90) {
    const all = this.sparks; this.sparks = [];
    if (all.length <= max) return { sparks: all, seen: all.length, all };
    const step = all.length / max, out = [];
    for (let i = 0; i < max; i++) out.push(all[Math.floor(i * step)]);
    return { sparks: out, seen: all.length, all };
  }

  // Forget internet hosts quiet for longer than `idleSec`, so the map stays readable.
  prune(now, idleSec = 900) {
    for (const [ip, h] of this.hosts) if (now - h.last > idleSec) this.hosts.delete(ip);
  }

  hostList() {
    return [...this.hosts.values()].map((h) => ({
      ip: h.ip, name: h.name, org: h.org || (h.name ? orgOf(h.name) : null),
      in: h.in, out: h.out, pkts: h.pkts, first: h.first, last: h.last,
      ports: h.ports, progs: h.progs,
    }));
  }

  lanList() { return [...this.lan.values()]; }

  // A lookup Pi-hole logged: which device asked for which name, and whether it was blocked.
  ingestLookup(l, piholeIp) {
    let d = this.devLookups.get(l.ip);
    if (!d) { d = { ip: l.ip, total: 0, blocked: 0, last: 0, domains: new Map() }; this.devLookups.set(l.ip, d); }
    d.total++; if (l.blocked) d.blocked++; d.last = Math.max(d.last, l.t);
    const e = d.domains.get(l.domain) || { n: 0, blocked: false, last: 0 };
    e.n++; e.blocked = e.blocked || l.blocked; e.last = l.t;
    d.domains.set(l.domain, e);
    if (d.domains.size > 400) {
      const oldest = [...d.domains.entries()].sort((a, b) => a[1].last - b[1].last).slice(0, 100);
      for (const [k] of oldest) d.domains.delete(k);
    }
    const from = this.local.has(l.ip) ? "pc" : l.ip === this.gateway ? "router" : `lan:${l.ip}`;
    return { s: from, d: piholeIp ? `lan:${piholeIp}` : "router", b: 90, k: l.blocked ? "blocked" : "dns",
             t: l.t, p: "udp", rp: 53, dom: l.domain, prog: null };
  }

  lookupList(top = 30) {
    return [...this.devLookups.values()].map((d) => ({
      ip: d.ip, total: d.total, blocked: d.blocked, last: d.last,
      top: [...d.domains.entries()].sort((a, b) => b[1].last - a[1].last).slice(0, top)
        .map(([dom, e]) => [dom, e.n, e.blocked, e.last]),
    }));
  }

  // Internet hosts with no name yet, busiest first.
  unnamed(limit = 10) {
    return [...this.hosts.values()].filter((h) => !h.name)
      .sort((a, b) => (b.in + b.out) - (a.in + a.out)).slice(0, limit).map((h) => h.ip);
  }

  topTalker(seconds = 10) {
    const acc = new Map();
    for (const s of this.series.slice(-seconds)) for (const [n, b] of s.top) acc.set(n, (acc.get(n) || 0) + b);
    let best = null, bb = 0;
    for (const [n, b] of acc) if (b > bb) { best = n; bb = b; }
    return best;
  }
}

module.exports = { Flows, HISTORY_SECONDS };
