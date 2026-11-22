// Huginn command center: Rewind, the network's CCTV.
// Huginn keeps a week of who-talked-to-whom (never packet contents). Rewind plays any moment
// back on the sky map. Loaded after app.js and shares its top-level names (S, sparks, addSparks...).
"use strict";

const replayBar = $("replayBar"), REPLAY_SPEEDS = [1, 4, 16, 60];

function localInput(sec) {
  const d = new Date(sec * 1000), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function rewindHtml() {
  const now = Math.floor(Date.now() / 1000), oldest = S.historyFrom || now - 60;
  const threeAm = new Date(); threeAm.setHours(3, 0, 0, 0);
  if (threeAm > new Date()) threeAm.setDate(threeAm.getDate() - 1);
  const picks = [[now - 5 * 60, "5 minutes ago"], [now - 3600, "1 hour ago"],
                 [Math.floor(threeAm / 1000), "Last 3 AM"], [now - 86400, "This time yesterday"]]
    .filter(([t]) => t >= oldest);
  return `<h2>Rewind</h2>
    <p class="sub">Huginn remembers back to ${esc(day(oldest))}. Pick a moment and the map plays it back, sparks and all.</p>
    ${picks.length ? `<div class="actions">${picks.map(([t, label]) => `<button type="button" data-act="replay" data-t="${t}">${label}</button>`).join("")}</div>` : ""}
    <form class="rewind rename">
      <label for="rwAt">Or pick a time</label>
      <input id="rwAt" type="datetime-local" min="${localInput(oldest)}" max="${localInput(now)}" value="${localInput(Math.max(oldest, now - 600))}">
      <div class="row"><button type="submit" class="primary">Replay</button></div>
    </form>
    <p class="note">Only who, when, how much and the site name are kept, never what was inside. Anything older than 7 days is deleted.</p>`;
}

// Capture phase, so the rename form's submit handler never sees this form.
drawerBody.addEventListener("submit", (e) => {
  if (!e.target.classList.contains("rewind")) return;
  e.preventDefault(); e.stopImmediatePropagation();
  const v = e.target.querySelector("#rwAt").value;
  if (v) startReplay(new Date(v).getTime() / 1000);
}, true);

function startReplay(at) {
  at = Math.floor(Math.max(at, S.historyFrom || 0));
  S.replay = { at, playing: true, speed: 1, buf: [], fetchedTo: at, fetching: false, seq: 0,
               names: new Map(), lastSpark: at, error: false };
  S.hosts = new Map(); sparks.length = 0; logEl.innerHTML = "";
  closeDrawer(); setPaused(false);
  replayBar.hidden = false; document.body.classList.add("replaying");
  $("rewindBtn").textContent = "Live"; $("rewindBtn").setAttribute("aria-pressed", "true");
  fetchReplay(); renderReplayBar(); layoutSoon();
}

function stopReplay(note) {
  if (!S.replay) return;
  S.replay = null; sparks.length = 0; logEl.innerHTML = "";
  replayBar.hidden = true; document.body.classList.remove("replaying");
  $("rewindBtn").textContent = "Rewind"; $("rewindBtn").setAttribute("aria-pressed", "false");
  if (note) toast(esc(note));
  // The live outer ring comes back with the next hosts update (every 2 s).
}

function seekReplay(t) {
  const R = S.replay; if (!R) return;
  const now = Date.now() / 1000;
  R.at = Math.max(S.historyFrom || 0, Math.min(now - 15, Math.floor(t)));
  R.buf = []; R.fetchedTo = Math.floor(R.at); R.seq++; R.fetching = false; R.lastSpark = R.at;
  sparks.length = 0; fetchReplay(); renderReplayBar();
}

async function fetchReplay() {
  const R = S.replay; if (!R || R.fetching) return;
  R.fetching = true;
  const seq = R.seq, from = R.fetchedTo;
  try {
    const r = await fetch(`api/history?from=${from}&until=${from + 300}`);
    const j = await r.json();
    if (S.replay !== R || R.seq !== seq) return;
    if (!r.ok) throw new Error(j.error);
    for (const [ip, nm] of Object.entries(j.names || {})) R.names.set(ip, { name: nm[0], org: nm[1] });
    R.buf.push(...j.seconds); R.fetchedTo = j.until; R.error = false;
    if (j.oldest) S.historyFrom = j.oldest;
  } catch { if (S.replay === R) R.error = true; }
  finally { if (S.replay === R && R.seq === seq) R.fetching = false; }
}

// One stored path-second becomes one spark; internet hosts get a place on the outer ring.
function replaySpark(t, f, R) {
  const [s, d, k, b, n] = f, now = Date.now() / 1000;
  for (const key of [s, d]) {
    if (!key.startsWith("net:")) continue;
    const ip = key.slice(4);
    let h = S.hosts.get(ip);
    if (!h) {
      const nm = R.names.get(ip) || {};
      h = { ip, name: nm.name || null, org: nm.org || null, in: 0, out: 0, pkts: 0, first: t, last: now, ports: {}, progs: {} };
      S.hosts.set(ip, h); layoutSoon();
    }
    h.last = now; h.pkts += n;
    if (key === s) h.in += b; else h.out += b;
  }
  return { t: t + hash(s + d) * 0.9, s, d, k, b, p: null, rp: null };
}

setInterval(() => {
  const R = S.replay; if (!R) return;
  const now = Date.now() / 1000;
  if (R.playing) {
    const next = R.at + 0.1 * R.speed, out = [];
    while (R.buf.length && R.buf[0].t < next) {
      const rec = R.buf.shift();
      if (rec.t >= R.at - 2) for (const f of rec.f) out.push(replaySpark(rec.t, f, R));
    }
    if (R.fetchedTo > next) R.at = next;   // otherwise wait at the edge of what's loaded
    if (out.length) { R.lastSpark = R.at; addSparks(out); logSparks(out); }
  }
  if (R.fetchedTo - R.at < 120 && R.fetchedTo < now - 10) fetchReplay();
  if (R.at > now - 12) return stopReplay("Caught up with now. Back to live.");
  renderReplayBar();
}, 100);

function renderReplayBar() {
  const R = S.replay; if (!R) return;
  $("rbClock").textContent = new Date(R.at * 1000).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
  $("rbPlay").textContent = R.playing ? "Pause" : "Play";
  $("rbSpeed").textContent = `${R.speed}x`;
  $("rbNote").textContent = R.error ? "Couldn't read Huginn's memory. Trying again."
    : R.at - R.lastSpark > 30 ? "Quiet here. Nothing was recorded; Huginn or this PC may have been off."
    : "The map shows the past. Line speeds at the top are live.";
}

function replayControl(what) {
  const R = S.replay; if (!R) return;
  if (what === "play") R.playing = !R.playing;
  if (what === "speed") R.speed = REPLAY_SPEEDS[(REPLAY_SPEEDS.indexOf(R.speed) + 1) % REPLAY_SPEEDS.length];
  if (what === "back") seekReplay(R.at - 60);
  if (what === "fwd") seekReplay(R.at + 60);
  if (what === "live") return stopReplay();
  renderReplayBar();
}
replayBar.addEventListener("click", (e) => { const b = e.target.closest("[data-rb]"); if (b) replayControl(b.dataset.rb); });
