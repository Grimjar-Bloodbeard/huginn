// Read-only client for Pi-hole v6's API (the Pi-hole on the Pi-hole host).
// Signs in with an app password, then reads the query log and summary.
// Never calls anything that changes Pi-hole.

const BLOCKED = /GRAVITY|REGEX|DENYLIST|BLACKLIST|BLOCKED|SPECIAL_DOMAIN/;

// One Pi-hole query record -> what Huginn needs. Pure, so it can be tested.
function toLookup(q) {
  if (!q || !q.domain || !q.client) return null;
  const ip = typeof q.client === "string" ? q.client : q.client.ip;
  if (!ip) return null;
  return {
    id: q.id, t: Number(q.time), ip, domain: String(q.domain).toLowerCase(),
    type: q.type || null, blocked: BLOCKED.test(String(q.status || "")),
  };
}

class PiholeClient {
  constructor({ url, password, fetchImpl = fetch }) {
    this.url = url.replace(/\/$/, "");
    this.password = password;
    this.fetch = fetchImpl;
    this.sid = null;
    this.seen = new Set();
    this.since = Math.floor(Date.now() / 1000) - 60;
  }

  async auth() {
    const r = await this.fetch(`${this.url}/api/auth`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: this.password }), signal: AbortSignal.timeout(5000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.session || !j.session.valid) {
      throw new Error(r.status === 401 ? "Pi-hole refused the app password" : `Pi-hole sign-in failed (${r.status})`);
    }
    this.sid = j.session.sid;
  }

  async get(path) {
    if (!this.sid) await this.auth();
    let r = await this.fetch(`${this.url}${path}`, { headers: { "X-FTL-SID": this.sid }, signal: AbortSignal.timeout(5000) });
    if (r.status === 401) { await this.auth(); r = await this.fetch(`${this.url}${path}`, { headers: { "X-FTL-SID": this.sid }, signal: AbortSignal.timeout(5000) }); }
    if (!r.ok) throw new Error(`Pi-hole answered ${r.status} for ${path.split("?")[0]}`);
    return r.json();
  }

  // Lookups since the last call, oldest first, each one once.
  async newLookups() {
    const now = Math.floor(Date.now() / 1000);
    const j = await this.get(`/api/queries?from=${this.since - 2}&until=${now + 1}&length=1000`);
    const out = [];
    for (const q of j.queries || []) {
      if (this.seen.has(q.id)) continue;
      const l = toLookup(q);
      if (l) { out.push(l); this.seen.add(q.id); }
    }
    if (this.seen.size > 20000) this.seen = new Set([...this.seen].slice(-5000));
    this.since = now;
    return out.sort((a, b) => a.t - b.t);
  }

  summary() { return this.get("/api/stats/summary"); }
}

module.exports = { PiholeClient, toLookup };
