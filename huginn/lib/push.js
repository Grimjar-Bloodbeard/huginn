// Phone alerts (Web Push). Each phone that taps "Turn on alerts" gives Huginn a subscription;
// Huginn sends short, encrypted notes through that phone's push service (Google's for Android
// Chrome). The push service carries them but can't read them. Keys and subscriptions live in data/.
"use strict";
const fs = require("fs");
const path = require("path");
const webpush = require("web-push");

// Only the real browser push services, so a subscription can't point Huginn at anything else.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/,
                    /^web\.push\.apple\.com$/, /\.push\.apple\.com$/];

function checkSub(sub) {
  if (!sub || typeof sub !== "object" || !sub.keys) return { ok: false, error: "That isn't a push subscription." };
  let u; try { u = new URL(String(sub.endpoint)); } catch { return { ok: false, error: "Bad push address." }; }
  if (u.protocol !== "https:" || !PUSH_HOSTS.some((re) => re.test(u.hostname))) return { ok: false, error: "That push service isn't one Huginn knows." };
  const b64 = /^[A-Za-z0-9_-]+=*$/;
  if (!b64.test(String(sub.keys.p256dh || "")) || !b64.test(String(sub.keys.auth || ""))) return { ok: false, error: "Bad push keys." };
  return { ok: true, sub: { endpoint: u.href, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } } };
}

class Push {
  constructor(dir, { send = webpush.sendNotification } = {}) {
    this.keyFile = path.join(dir, "push.local.json");
    this.subFile = path.join(dir, "push-subs.json");
    this.sendImpl = send;
    fs.mkdirSync(dir, { recursive: true });
    let keys = null;
    try { keys = JSON.parse(fs.readFileSync(this.keyFile, "utf8")); } catch { /* first run */ }
    if (!keys || !keys.publicKey) {
      keys = webpush.generateVAPIDKeys();
      fs.writeFileSync(this.keyFile, JSON.stringify(keys));
    }
    this.keys = keys;
    try { this.subs = JSON.parse(fs.readFileSync(this.subFile, "utf8")); } catch { this.subs = []; }
  }
  save() { fs.writeFileSync(this.subFile + ".tmp", JSON.stringify(this.subs, null, 2)); fs.renameSync(this.subFile + ".tmp", this.subFile); }
  add(sub) { this.subs = this.subs.filter((s) => s.endpoint !== sub.endpoint).concat({ ...sub, added: Math.floor(Date.now() / 1000) }).slice(-10); this.save(); }
  remove(endpoint) { const n = this.subs.length; this.subs = this.subs.filter((s) => s.endpoint !== endpoint); if (n !== this.subs.length) this.save(); }
  has(endpoint) { return this.subs.some((s) => s.endpoint === endpoint); }

  // { title, body, url, tag } to every subscribed phone. Gone subscriptions are dropped.
  async send(note) {
    const payload = JSON.stringify({ title: String(note.title).slice(0, 80), body: String(note.body || "").slice(0, 240), url: note.url || "./", tag: note.tag || "huginn" });
    const results = await Promise.all(this.subs.map(async (s) => {
      try {
        await this.sendImpl({ endpoint: s.endpoint, keys: s.keys }, payload, {
          TTL: 6 * 3600, urgency: "high",
          vapidDetails: { subject: "mailto:huginn@example.invalid", publicKey: this.keys.publicKey, privateKey: this.keys.privateKey },
        });
        return { ok: true };
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) this.remove(s.endpoint);
        return { ok: false, error: e.statusCode ? `push service said ${e.statusCode}` : e.message };
      }
    }));
    return { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok) };
  }
}

module.exports = { Push, checkSub };
