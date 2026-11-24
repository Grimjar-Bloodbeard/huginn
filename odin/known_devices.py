"""
Odin's Watch - device memory (2026-10-26).

Remembers every device ever seen (by MAC) in devices.json: when it first and last showed up,
the router's name for it, and the name the owner gave it. After each scan, anything never seen
before is "new" and gets one phone alert. The very first run only learns (no alert flood).

devices.json is gitignored (it is a map of the home network).
"""

import json
import os
import subprocess
import time
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
STORE = BASE_DIR / "devices.json"
ROUTER_BASELINE = BASE_DIR / "devices.router-baseline"  # marker: router list has been learned once
PUSH_SCRIPT = BASE_DIR.parent / "scripts" / "odin-push.js"


def load():
    try:
        return json.loads(STORE.read_text(encoding="utf-8"))
    except Exception:
        return None


def save(known):
    tmp = STORE.with_suffix(".tmp")
    tmp.write_text(json.dumps(known, indent=1), encoding="utf-8")
    os.replace(tmp, STORE)


def is_private_mac(mac):
    """Phones and tablets often make up a random MAC per network (second hex digit 2, 6, A or E)."""
    return len(mac or "") >= 2 and mac[1].upper() in "26AE"


def merge(scanned, leases=None, now=None):
    """Fold one scan into memory. Returns (devices_for_topology, new_devices)."""
    now = now or time.time()
    known = load()
    first_run = known is None
    known = known or {}
    lease_names = {l["mac"]: l.get("hostname") for l in (leases or []) if l.get("mac")}
    seen, new = set(), []
    scanned_macs = {(d.get("mac") or "").upper() for d in scanned}
    # The router's device list counts too: sleeping phones and TVs often ignore the scan
    # but the router still has them connected (2026-10-26).
    router_only = [{"mac": l["mac"], "ip": l.get("ip"), "hostname": l.get("hostname"), "vendor": None}
                   for l in (leases or []) if l.get("mac") and l["mac"] not in scanned_macs]

    # First time the router's list is used, its devices are learned quietly (no alert flood).
    router_first = bool(router_only) and not ROUTER_BASELINE.exists()

    for d in list(scanned) + router_only:
        mac = (d.get("mac") or "").upper()
        if not mac:
            continue
        seen.add(mac)
        rec = known.get(mac)
        if rec is None:
            # baseline = was already here on the very first scan, so it's never shown as "new"
            quiet = first_run or (router_first and mac not in scanned_macs)
            rec = {"first_seen": now, "label": None, "baseline": quiet}
            known[mac] = rec
            if not quiet:
                new.append(d)
        if mac in scanned_macs:
            rec.update({"last_seen": now, "ip": d.get("ip"), "vendor": d.get("vendor"),
                        "hostname": d.get("hostname"), "device_type": d.get("device_type"),
                        "subnet": d.get("subnet"), "role": d.get("role")})
        else:  # router-only: keep what the scan learned before, refresh time and address
            rec.update({"last_seen": now, "ip": d.get("ip") or rec.get("ip")})
        if lease_names.get(mac):
            rec["router_name"] = lease_names[mac]

    save(known)
    if router_first:
        ROUTER_BASELINE.write_text(str(now), encoding="utf-8")

    out = []
    for mac, rec in known.items():
        out.append({
            "mac": mac, "ip": rec.get("ip"), "vendor": rec.get("vendor"),
            "hostname": rec.get("hostname"), "router_name": rec.get("router_name"),
            "label": rec.get("label"), "device_type": rec.get("device_type"),
            "subnet": rec.get("subnet"), "role": rec.get("role"),
            "open_ports": next((d.get("open_ports") for d in scanned if (d.get("mac") or "").upper() == mac), []),
            "status": "online" if mac in seen else "offline",
            "seen_by": ("both" if mac in scanned_macs and mac in lease_names else
                        "scan" if mac in scanned_macs else "router" if mac in seen else None),
            "first_seen": rec.get("first_seen"), "last_seen": rec.get("last_seen"),
            "baseline": bool(rec.get("baseline")),
            "private_mac": is_private_mac(mac),
        })
    # Devices the scan found by address only (no hardware ID, e.g. on Android). Shown on the map
    # but never remembered: an address alone changes with DHCP, so tracking it would raise
    # false "new device" alerts.
    for d in scanned:
        if d.get("mac"):
            continue
        out.append({
            "mac": None, "ip": d.get("ip"), "vendor": None, "hostname": d.get("hostname"),
            "router_name": None, "label": None, "device_type": d.get("device_type"),
            "subnet": d.get("subnet"), "role": d.get("role"), "open_ports": d.get("open_ports") or [],
            "status": "online", "seen_by": "scan", "first_seen": None,
            "last_seen": d.get("last_seen"), "baseline": True, "private_mac": False,
        })
    return out, new


def set_label(mac, label):
    known = load() or {}
    mac = (mac or "").upper()
    if mac not in known:
        return False
    label = (label or "").strip()[:60]
    known[mac]["label"] = label or None
    save(known)
    return True


def alert_new(new_devices):
    """One push for all new devices, through the configured phone notifications."""
    if not new_devices:
        return
    parts = []
    for d in new_devices[:5]:
        who = d.get("hostname") or d.get("vendor") or "unknown maker"
        extra = " (random MAC, likely a phone or tablet)" if is_private_mac(d.get("mac")) else ""
        parts.append(f"{who} at {d.get('ip')}{extra}")
    more = f" and {len(new_devices) - 5} more" if len(new_devices) > 5 else ""
    title = "New device on your network" if len(new_devices) == 1 else f"{len(new_devices)} new devices on your network"
    body = "; ".join(parts) + more + ". Name it in Odin's Watch if it's yours."
    try:
        subprocess.run(["node", str(PUSH_SCRIPT), title, body], timeout=20,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except Exception:
        pass  # a failed alert must never break the scan
