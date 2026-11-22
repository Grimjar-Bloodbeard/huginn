#!/usr/bin/env python3
"""
Odin's Watch - IoT-side isolation probe.

Run this ON a device physically connected to the IoT subnet (a spare
laptop briefly joined to the IoT wifi, a Raspberry Pi sitting on that
VLAN, or a phone via Termux). It attempts to reach targets on your
trusted LAN and reports the result back to the main dashboard.

Pure stdlib - nothing to pip install. Safe to copy onto anything with
Python 3.6+, including Termux on Android.

Usage:
    python iot_probe.py --dashboard 192.168.1.50:7331 --targets 192.168.1.1,192.168.1.50

If this device truly cannot reach the trusted subnet, the POST back to
the dashboard will ALSO fail - that's not a bug, it's the isolation
working. In that case the full JSON result prints to the terminal so you
can paste it into the dashboard's manual-report box yourself.
"""

import argparse
import json
import platform
import subprocess
import time
import urllib.request
import urllib.error

IS_WINDOWS = platform.system() == "Windows"


def ping(target, count=3, timeout_ms=1000):
    received = 0
    latencies = []
    for _ in range(count):
        if IS_WINDOWS:
            cmd = ["ping", "-n", "1", "-w", str(timeout_ms), target]
        else:
            cmd = ["ping", "-c", "1", "-W", str(max(1, timeout_ms // 1000)), target]
        start = time.perf_counter()
        try:
            result = subprocess.run(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                timeout=(timeout_ms / 1000) + 1.5,
            )
            # TTL= only appears on a real reply; Windows exits 0 on a router's "unreachable" too
            if result.returncode == 0 and "ttl=" in result.stdout.decode(errors="ignore").lower():
                received += 1
                latencies.append(round((time.perf_counter() - start) * 1000, 1))
        except Exception:
            pass
    return {
        "target": target,
        "sent": count,
        "received": received,
        "reachable": received > 0,
        "latencies_ms": latencies,
    }


def build_report(targets, count):
    results = [ping(t, count=count) for t in targets]
    any_reachable = any(r["reachable"] for r in results)
    return {
        "direction": "iot_to_trusted",
        "probe_host_platform": platform.platform(),
        "targets": results,
        "any_target_reachable": any_reachable,
        "isolation_effective": not any_reachable,
        "timestamp": time.time(),
    }


def post_report(dashboard, report):
    url = f"http://{dashboard}/api/isolation-report"
    data = json.dumps(report).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return resp.status


def main():
    parser = argparse.ArgumentParser(description="Odin's Watch IoT-side isolation probe")
    parser.add_argument("--dashboard", required=True,
                         help="host:port of the Odin's Watch dashboard, e.g. 192.168.1.50:7331")
    parser.add_argument("--targets", required=True,
                         help="comma-separated trusted-subnet IPs to test, e.g. gateway,dashboard host")
    parser.add_argument("--count", type=int, default=3, help="pings per target")
    args = parser.parse_args()

    targets = [t.strip() for t in args.targets.split(",") if t.strip()]
    print(f"[odin-probe] testing IoT -> trusted reachability against: {targets}")

    report = build_report(targets, args.count)

    for r in report["targets"]:
        status = "REACHABLE" if r["reachable"] else "blocked/unreachable"
        print(f"[odin-probe] {r['target']}: {status} "
              f"({r['received']}/{r['sent']} replies)")

    if report["isolation_effective"]:
        print("[odin-probe] no trusted-subnet target answered - isolation looks EFFECTIVE from here.")
    else:
        print("[odin-probe] at least one trusted-subnet target answered - isolation LEAK from here.")

    print(f"[odin-probe] reporting back to dashboard at {args.dashboard} ...")
    try:
        post_report(args.dashboard, report)
        print("[odin-probe] report delivered to dashboard successfully.")
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        print(f"[odin-probe] could not reach the dashboard to report in ({exc}).")
        print("[odin-probe] if isolation is working, THIS is expected - the same "
              "block that stops pings is stopping this HTTP report too.")
        print("[odin-probe] paste the JSON below into the dashboard's manual isolation-report box:")
        print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
