/* Odin's Watch dashboard - topology graph (vis-network) + device list +
   diagnostics + a live scan log over SSE. The Flask backend (app.py) was
   already built with all of this in mind (rescan endpoint, /api/events
   log stream, CORS'd /api/diagnostics for an external HUD to poll) -
   this file is the missing front end for a backend that's been running
   headless since 2026-08-23. */
(function () {
  const SUBNET_COLORS = {}; // filled in from topology's own subnets on load

  function timeAgo(unixSeconds) {
    if (!unixSeconds) return 'never';
    const s = Math.max(0, Math.round(Date.now() / 1000 - unixSeconds));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }

  // Device names come from the devices themselves (mDNS, DHCP), so any gadget on the network
  // can pick one. Escape everything before it touches innerHTML.
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function nameOf(d) { return d.label || d.router_name || d.hostname || d.ip || d.mac; }
  const NEW_WINDOW_S = 24 * 3600;
  function isNew(d) { return !d.baseline && d.first_seen && (Date.now() / 1000 - d.first_seen) < NEW_WINDOW_S; }
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Odin': '1' }, body: JSON.stringify(body || {}) });

  let network = null;
  function renderGraph(topology) {
    const nodes = [];
    const edges = [];
    (topology.subnets || []).forEach((s) => { SUBNET_COLORS[s.name] = s.color || '#4ff0e0'; });

    // One hub node per subnet, every device in that subnet edges to its hub -
    // a real star topology per subnet, not a guess at actual switch wiring
    // we have no data for.
    const hubIds = {};
    (topology.subnets || []).forEach((s, i) => {
      const id = 'hub:' + s.name;
      hubIds[s.name] = id;
      nodes.push({ id, label: s.name, shape: 'box', color: { background: '#111', border: s.color || '#4ff0e0' },
        font: { color: s.color || '#4ff0e0', size: 12 }, margin: 8 });
    });

    (topology.devices || []).forEach((d) => {
      const color = d.status === 'online' ? (SUBNET_COLORS[d.subnet] || '#4ff0e0') : '#555';
      nodes.push({
        id: d.mac || d.ip,
        label: nameOf(d),
        // vis-network shows a string title as plain text, so no escaping needed here.
        title: `${d.vendor || 'unknown vendor'}\n${d.device_type || ''}\n${d.ip || ''}\nports: ${(d.open_ports || []).join(', ') || 'none seen'}`,
        shape: 'dot', size: 12,
        color: { background: color, border: color },
        font: { color: '#eef2f5', size: 10 },
      });
      // Router-only devices have no subnet from the scan: match by address instead.
      const net = d.subnet || ((topology.subnets || []).find((s) => s.gateway && d.ip &&
        s.gateway.split('.').slice(0, 3).join('.') === d.ip.split('.').slice(0, 3).join('.')) || {}).name;
      if (hubIds[net]) edges.push({ from: hubIds[net], to: d.mac || d.ip, color: { color: '#2a3540' }, dashes: d.seen_by === 'router' });
    });

    const data = { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) };
    const options = {
      physics: { stabilization: true, barnesHut: { gravitationalConstant: -4000, springLength: 90 } },
      interaction: { hover: true },
      layout: { improvedLayout: true },
    };
    const container = document.getElementById('network-graph');
    if (network) network.destroy();
    network = new vis.Network(container, data, options);
  }

  // Plain-language guess at what a device is, from its names and maker (2026-10-26).
  const KINDS = [
    ['Router', (t, d) => d.role === 'gateway' || /(router|cudy|archer|gateway)/.test(t)],
    ['Google / Nest', (t) => /google|nest|chromecast|home-?mini|googlehome/.test(t)],
    ['TV', (t) => /tv|roku|vizio|tcl|hisense|bravia|webos|tizen|fire-?tv|lg ?electronics|smart-?tv/.test(t)],
    ['Game console', (t) => /xbox|playstation|ps[45]|nintendo|switch/.test(t)],
    ['Phone / tablet', (t, d) => /iphone|ipad|pixel|android|galaxy|phone|tablet/.test(t) || d.private_mac],
    ['Computer', (t) => /desktop|laptop|pc|windows|macbook|imac|thinkpad/.test(t)],
    ['Printer', (t) => /printer|epson|canon|brother|hp/.test(t)],
  ];
  function kindOf(d) {
    const t = [d.label, d.router_name, d.hostname, d.vendor, d.device_type].filter(Boolean).join(' ').toLowerCase();
    const hit = KINDS.find(([, test]) => test(t, d));
    return hit ? hit[0] : (d.device_type && d.device_type !== '?' ? d.device_type : 'Unknown');
  }
  function seenBy(d) {
    if (d.seen_by === 'router') return 'router says connected (did not answer the scan)';
    if (d.seen_by === 'scan') return 'answered the scan (router did not list it)';
    return '';
  }

  function deviceRow(d) {
    const on = d.status === 'online';
    const sub = [kindOf(d), d.ip, on ? seenBy(d) : 'last seen ' + timeAgo(d.last_seen)].filter(Boolean).join(' · ');
    return `
      <div class="device-row${on ? '' : ' is-offline'}" data-mac="${esc(d.mac)}" title="${esc((d.vendor || 'unknown maker') + ' · ' + d.mac)}">
        <span class="device-dot ${on ? 'online' : 'offline'}"></span>
        <div class="device-info">
          <div class="device-name">${esc(nameOf(d))}${isNew(d) ? ' <span class="tag-new">new</span>' : ''}${d.private_mac ? ' <span class="tag-rand" title="Random MAC: usually a phone or tablet">rand</span>' : ''}</div>
          <div class="device-sub">${esc(sub)}</div>
          <form class="rename" hidden><input maxlength="60" aria-label="Name for this device" placeholder="Name it, e.g. Living room TV"><button type="submit">Save</button></form>
        </div>
        <div class="device-ports" title="Open ports: doors this device answers on">${esc((d.open_ports || []).join(',') || '-')}</div>
        <button class="rename-btn" type="button" aria-label="Rename ${esc(nameOf(d))}">Name</button>
      </div>`;
  }

  function renderDeviceList(topology) {
    const list = document.getElementById('device-list');
    const all = topology.devices || [];
    if (!all.length) { list.textContent = 'No devices seen yet - run a rescan.'; return; }
    const byName = (a, b) => kindOf(a).localeCompare(kindOf(b)) || String(nameOf(a)).localeCompare(String(nameOf(b)));
    const on = all.filter((d) => d.status === 'online').sort(byName);
    const off = all.filter((d) => d.status !== 'online').sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0));
    list.innerHTML =
      `<h3 class="list-head">Connected now <span>${on.length}</span></h3>` +
      (on.map(deviceRow).join('') || '<p class="list-empty">Nothing connected right now.</p>') +
      `<h3 class="list-head off">Not connected <span>${off.length}</span></h3>` +
      (off.map(deviceRow).join('') || '<p class="list-empty">Every device Odin has ever seen is connected.</p>');
  }

  // Rename: one button per row opens a small inline form (no browser pop-ups).
  document.getElementById('device-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.rename-btn');
    if (!btn) return;
    const row = btn.closest('.device-row');
    const form = row.querySelector('.rename');
    form.hidden = !form.hidden;
    if (!form.hidden) { const inp = form.querySelector('input'); inp.value = row.querySelector('.device-name').firstChild.textContent; inp.focus(); inp.select(); }
  });
  document.getElementById('device-list').addEventListener('submit', async (e) => {
    e.preventDefault();
    const row = e.target.closest('.device-row');
    const label = e.target.querySelector('input').value;
    const r = await post('/api/devices/label', { mac: row.dataset.mac, label });
    if (r.ok) loadTopology();
  });

  async function loadRouter() {
    const body = document.getElementById('router-body');
    const r = await (await fetch('/api/router')).json();
    if (!r.configured) { body.textContent = 'Not connected. Run set-router-password.ps1 on the PC to link it (read-only).'; return; }
    if (r.note) { body.textContent = r.note; return; }
    if (!r.ok) { body.innerHTML = diagRow('Router', esc(r.error), 'bad'); return; }
    let html = diagRow('Signed in', 'read-only', 'ok');
    (r.networks || []).forEach((n) => { html += diagRow(esc(n.name) + ' network', esc(n.address + '/' + n.mask) + (n.up ? '' : ' (down)'), n.up ? 'ok' : 'warn'); });
    html += diagRow('Devices the router lists', String(r.leases));
    body.innerHTML = html;
  }

  async function loadTopology() {
    const topology = await (await fetch('/api/topology')).json();
    const online = (topology.devices || []).filter((d) => d.status === 'online').length;
    document.getElementById('device-count').textContent = `${online} connected · ${(topology.devices || []).length - online} not connected`;
    document.getElementById('last-scan').textContent = 'scanned ' + timeAgo(topology.generated_at);
    renderGraph(topology);
    renderDeviceList(topology);
  }

  function diagRow(label, val, cls) {
    return `<div class="diag-row"><span class="diag-label">${label}</span><span class="diag-val ${cls || ''}">${val}</span></div>`;
  }

  async function loadDiagnostics() {
    const d = await (await fetch('/api/diagnostics')).json();
    const body = document.getElementById('diagnostics-body');
    if (d.note) { body.textContent = d.note; return; }
    let html = '';
    for (const [name, stats] of Object.entries(d.gateways || {})) {
      const cls = stats.loss_pct === 0 ? 'ok' : stats.loss_pct < 50 ? 'warn' : 'bad';
      html += diagRow(esc(name) + ' gateway', `${stats.loss_pct}% loss`, cls);
    }
    if (d.double_nat) {
      html += diagRow('Double-NAT', d.double_nat.double_nat_suspected ? 'suspected' : 'not detected',
        d.double_nat.double_nat_suspected ? 'warn' : 'ok');
    }
    if (d.isolation_local) {
      html += diagRow('Trusted→IoT reachable', d.isolation_local.reachable ? 'YES (not isolated)' : 'no',
        d.isolation_local.reachable ? 'bad' : 'ok');
    }
    if (d.isolation_remote) {
      html += diagRow('IoT→Trusted reachable', d.isolation_remote.any_target_reachable ? 'YES (leak)' : 'no',
        d.isolation_remote.any_target_reachable ? 'bad' : 'ok');
    }
    body.innerHTML = html || 'No diagnostics data yet.';
  }

  // ── rescan + live log ────────────────────────────────────────────────
  const logPanel = document.getElementById('log-panel');
  const logBody = document.getElementById('log-body');
  const rescanBtn = document.getElementById('rescan-btn');
  let eventSource = null;

  function appendLog(line) {
    const div = document.createElement('div');
    div.textContent = line.message;
    logBody.appendChild(div);
    logBody.scrollTop = logBody.scrollHeight;
  }

  function startLogStream() {
    if (eventSource) return;
    logPanel.classList.remove('collapsed');
    eventSource = new EventSource('/api/events');
    eventSource.onmessage = (e) => {
      const line = JSON.parse(e.data);
      appendLog(line);
      if (line.message.includes('diagnostics complete')) {
        rescanBtn.disabled = false;
        rescanBtn.textContent = 'Rescan';
        loadTopology();
        loadDiagnostics();
        loadRouter();
        eventSource.close();
        eventSource = null;
      }
    };
    eventSource.onerror = () => { eventSource.close(); eventSource = null; };
  }

  rescanBtn.addEventListener('click', async () => {
    rescanBtn.disabled = true;
    rescanBtn.textContent = 'Scanning...';
    logBody.innerHTML = '';
    await post('/api/rescan');
    startLogStream();
  });

  document.querySelector('.log-header').addEventListener('click', () => logPanel.classList.toggle('collapsed'));

  loadTopology();
  loadDiagnostics();
  loadRouter();
  // Auto-rescans happen in the background every few minutes; keep the page current.
  setInterval(() => { if (!eventSource) { loadTopology(); loadDiagnostics(); loadRouter(); } }, 60000);
})();
