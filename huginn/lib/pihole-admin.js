// The one place Huginn changes Pi-hole: groups, client entries and the Quarantine rule.
// Used only when you tap Move after seeing exactly what will change (zones). lib/pihole.js stays read-only.
"use strict";

const QUARANTINE_RULE = ".*";   // a regex that matches every name, attached to the Huginn-Quarantine group only

class PiholeAdmin {
  constructor({ url, password, fetchImpl = fetch }) {
    this.url = url.replace(/\/$/, "");
    this.password = password;
    this.fetch = fetchImpl;
    this.sid = null;
  }

  async auth() {
    const r = await this.fetch(`${this.url}/api/auth`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: this.password }), signal: AbortSignal.timeout(5000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.session || !j.session.valid) throw new Error(r.status === 401 ? "Pi-hole refused the app password" : `Pi-hole sign-in failed (${r.status})`);
    this.sid = j.session.sid;
  }

  async req(method, path, body) {
    if (!this.sid) await this.auth();
    const go = () => this.fetch(`${this.url}${path}`, {
      method, signal: AbortSignal.timeout(8000),
      headers: { "X-FTL-SID": this.sid, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let r = await go();
    if (r.status === 401) { await this.auth(); r = await go(); }
    if (r.status === 204) return {};
    const j = await r.json().catch(() => ({}));
    if (method === "DELETE" && r.status === 404) return { missing: true };
    if (!r.ok) throw new Error(`Pi-hole said no to ${method} ${path.split("/").slice(0, 3).join("/")} (${r.status}${j.error && j.error.message ? `: ${j.error.message}` : ""})`);
    const errs = j.processed && j.processed.errors;
    if (errs && errs.length) throw new Error(`Pi-hole: ${errs.map((e) => e.error).join(", ")}`);
    return j;
  }

  async groups() { return (await this.req("GET", "/api/groups")).groups || []; }
  async findGroup(name) { return (await this.groups()).find((g) => g.name === name) || null; }
  async ensureGroup(name, comment) {
    let g = await this.findGroup(name);
    if (g) return g.id;
    await this.req("POST", "/api/groups", { name, comment, enabled: true });
    g = await this.findGroup(name);
    if (!g) throw new Error(`Pi-hole didn't keep the group ${name}`);
    return g.id;
  }

  // Client entries, matched without caring about letter case (Pi-hole may store MACs either way).
  async client(mac) {
    const list = (await this.req("GET", "/api/clients")).clients || [];
    const c = list.find((x) => String(x.client).toUpperCase() === mac.toUpperCase());
    return c ? { client: c.client, groups: [...(c.groups || [])], comment: c.comment ?? null } : null;
  }
  async putClient(existing, mac, groups, comment) {
    if (existing) return this.req("PUT", `/api/clients/${existing.client}`, { groups, comment });
    return this.req("POST", "/api/clients", { client: mac, groups, comment });
  }
  async deleteClient(entry) { return this.req("DELETE", `/api/clients/${entry.client}`); }

  async quarantineRule() {
    const list = (await this.req("GET", "/api/domains/deny/regex")).domains || [];
    return list.find((d) => d.domain === QUARANTINE_RULE) || null;
  }
  // Added switched off first, checked, then switched on, so it can never land on the Default
  // group (which would stop every device in the house from looking anything up).
  async ensureQuarantineRule(qid) {
    const have = await this.quarantineRule();
    if (have) {
      const gs = have.groups || [];
      if (gs.length === 1 && gs[0] === qid && have.enabled) return;
      if (!(gs.length === 1 && gs[0] === qid)) throw new Error("Pi-hole already has a block-everything rule that isn't Huginn's. Huginn won't touch it.");
    } else {
      await this.req("POST", "/api/domains/deny/regex", { domain: QUARANTINE_RULE, groups: [qid], enabled: false,
        comment: "Huginn Quarantine: refuses every lookup, only for devices in the Huginn-Quarantine group" });
      const added = await this.quarantineRule();
      const gs = (added && added.groups) || [];
      if (!(gs.length === 1 && gs[0] === qid)) {
        await this.req("DELETE", `/api/domains/deny/regex/${QUARANTINE_RULE}`).catch(() => {});
        throw new Error("Pi-hole put the Quarantine rule on the wrong group, so Huginn removed it again.");
      }
    }
    await this.req("PUT", `/api/domains/deny/regex/${QUARANTINE_RULE}`, { groups: [qid], enabled: true,
      comment: "Huginn Quarantine: refuses every lookup, only for devices in the Huginn-Quarantine group" });
  }
}

module.exports = { PiholeAdmin, QUARANTINE_RULE };
