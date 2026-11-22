// Phase 1 grading: turns raw source checks into plain lines + a done flag.
// Pure (no system calls) so it can be tested. Never prints values from the
// sources (device names, domains, addresses), only counts and yes/no.

const MIN_PIHOLE_CLIENTS = 2; // this PC plus at least one more device asking Pi-hole on the Pi-hole host

function grade(r) {
  const lines = [];
  const ok = {};

  // Windows Security log (logons, account changes)
  ok.security = r.security === "readable";
  lines.push(ok.security
    ? "PASS  Windows Security log: readable"
    : r.security === "denied"
      ? "TODO  Windows Security log: access denied. Run setup/phase1-admin.ps1 as admin, then sign out and back in."
      : `FAIL  Windows Security log: ${r.security}`);

  // Sysmon (what programs ran, what they connected to)
  ok.sysmon = Number.isFinite(r.sysmonRecords) && r.sysmonRecords > 0;
  lines.push(ok.sysmon
    ? `PASS  Sysmon: installed, ${r.sysmonRecords} events logged`
    : r.sysmonRecords === null
      ? "TODO  Sysmon: not installed. Run setup/phase1-admin.ps1 as admin."
      : r.sysmonRecords === "denied"
        ? "TODO  Sysmon: installed but not readable yet. Sign out and back in."
        : "WAIT  Sysmon: installed, no events yet. Use the PC for a minute and run again.");

  // Pi-hole (every website lookup on the network)
  const p = r.pihole || {};
  ok.pihole = p.up === true && p.clients >= MIN_PIHOLE_CLIENTS;
  lines.push(!p.up
    ? `FAIL  Pi-hole: not reachable (${p.error || "unknown"})`
    : ok.pihole
      ? `PASS  Pi-hole: ${p.clients} devices, ${p.queries} lookups in the last 24 h`
      : `TODO  Pi-hole: only ${p.clients} device(s) asking it. The router's DHCP DNS should be the Pi-hole host; reconnect the phone's wifi.`);

  // Odin's Watch (which devices are on the network)
  ok.odin = Number.isFinite(r.odinDevices) && r.odinDevices > 0;
  lines.push(ok.odin
    ? `PASS  Odin's Watch: ${r.odinDevices} known devices`
    : `FAIL  Odin's Watch: device list not readable (${r.odinError || "empty"})`);

  // the Pi-hole host's system log: checked by hand in phase 1
  ok.olReliable = r.olReliable === true;
  lines.push(ok.olReliable
    ? "PASS  the Pi-hole host log: confirmed"
    : "TODO  the Pi-hole host log: on the Pi-hole host run `journalctl -n 5`, then set olReliableConfirmed: true in config.local.json");

  const done = Object.values(ok).every(Boolean);
  return { lines, ok, done };
}

module.exports = { grade, MIN_PIHOLE_CLIENTS };
