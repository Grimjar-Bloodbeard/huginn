"""
Odin's Watch - diagnostics: gateway health, double-NAT detection, and the
trusted-side half of the subnet isolation check.

Honesty note on isolation: a check that only runs from this host can prove
"trusted can reach IoT" at best. It cannot prove the direction that
actually matters for security (whether an IoT device can reach the
trusted LAN), because that requires a probe running ON the IoT subnet.
See iot_probe.py - it posts its result to /api/isolation-report, and
that's the value get_isolation_report() below picks up as "remote_result".
"""

import platform
import re
import statistics
import subprocess
import time

IS_WINDOWS = platform.system() == "Windows"

_latest_remote_isolation_report = None


def ping_stats(ip, count=8, timeout_ms=1000):
    """Ping a host N times, return latency/loss stats."""
    latencies = []
    sent = 0

    for _ in range(count):
        sent += 1
        if IS_WINDOWS:
            cmd = ["ping", "-n", "1", "-w", str(timeout_ms), str(ip)]
        else:
            cmd = ["ping", "-c", "1", "-W", str(max(1, timeout_ms // 1000)), str(ip)]
        start = time.perf_counter()
        try:
            result = subprocess.run(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                timeout=(timeout_ms / 1000) + 1.5,
            )
            elapsed_ms = (time.perf_counter() - start) * 1000
            text = result.stdout.decode(errors="ignore")
            # TTL= only appears on a real reply; Windows exits 0 on a router's "unreachable" too
            if result.returncode == 0 and "ttl=" in text.lower():
                match = re.search(r"time[=<]([\d.]+)\s*ms", text, re.IGNORECASE)
                latencies.append(float(match.group(1)) if match else elapsed_ms)
        except Exception:
            pass

    loss_pct = round(100 * (sent - len(latencies)) / sent, 1) if sent else 100.0
    return {
        "target": ip,
        "sent": sent,
        "received": len(latencies),
        "loss_pct": loss_pct,
        "avg_ms": round(statistics.mean(latencies), 1) if latencies else None,
        "min_ms": round(min(latencies), 1) if latencies else None,
        "max_ms": round(max(latencies), 1) if latencies else None,
    }


_PRIVATE_RANGES = (
    ("10.", ),
    ("172.16.", "172.17.", "172.18.", "172.19.", "172.20.", "172.21.",
     "172.22.", "172.23.", "172.24.", "172.25.", "172.26.", "172.27.",
     "172.28.", "172.29.", "172.30.", "172.31."),
    ("192.168.", ),
)


def _is_private_ip(ip):
    return any(ip.startswith(prefix) for group in _PRIVATE_RANGES for prefix in group)


_TRACE_HOP_WIN = re.compile(
    r"^\s*\d+\s+.*?(\d{1,3}(?:\.\d{1,3}){3})\s*$", re.MULTILINE
)
_TRACE_HOP_POSIX = re.compile(
    r"^\s*\d+\s+\S+\s+\((\d{1,3}(?:\.\d{1,3}){3})\)", re.MULTILINE
)


def check_double_nat(target="1.1.1.1", max_hops=6):
    """Trace toward target and flag 2+ consecutive private-IP hops.

    A single private hop (your own gateway) is normal. A second private
    hop before anything public shows up means there's another NAT layer
    between your router and the internet (ISP modem in router mode, a
    second router, etc).
    """
    if IS_WINDOWS:
        cmd = ["tracert", "-d", "-h", str(max_hops), "-w", "1000", target]
        pattern = _TRACE_HOP_WIN
    else:
        cmd = ["traceroute", "-n", "-m", str(max_hops), "-w", "1", target]
        pattern = _TRACE_HOP_POSIX

    try:
        output = subprocess.run(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=20,
        ).stdout.decode(errors="ignore")
    except Exception as exc:
        return {"error": str(exc), "double_nat_suspected": None, "hops": []}

    hops = pattern.findall(output)
    private_streak = 0
    for hop_ip in hops:
        if _is_private_ip(hop_ip):
            private_streak += 1
        else:
            break

    return {
        "hops": hops,
        "private_hop_count_before_public": private_streak,
        "double_nat_suspected": private_streak >= 2,
    }


def check_local_isolation(trusted_to_iot_target, timeout_ms=1000):
    """Best-effort check FROM this host toward an IoT-subnet target.

    Only proves reachability in the trusted->IoT direction. Labeled
    explicitly so the dashboard doesn't imply it's the full picture.
    """
    stats = ping_stats(trusted_to_iot_target, count=3, timeout_ms=timeout_ms)
    return {
        "direction": "trusted_to_iot",
        "target": trusted_to_iot_target,
        "reachable": stats["received"] > 0,
        "note": "This only tests trusted->IoT. The direction that actually "
                "matters (IoT->trusted) requires iot_probe.py run from a "
                "device on the IoT subnet.",
        "stats": stats,
    }


def record_remote_isolation_report(report):
    """Store the latest report POSTed by iot_probe.py from the IoT side."""
    global _latest_remote_isolation_report
    report = dict(report)
    report["received_at"] = time.time()
    _latest_remote_isolation_report = report
    return report


def get_remote_isolation_report():
    return _latest_remote_isolation_report


def run_full_diagnostics(config):
    log = []

    def note(msg):
        log.append(msg)

    diag_cfg = config.get("diagnostics", {})
    results = {"log": log, "generated_at": time.time()}

    for subnet in config["subnets"]:
        gateway = subnet.get("gateway")
        if not gateway:
            continue
        note(f"pinging gateway {gateway} ({subnet['name']})")
        results.setdefault("gateways", {})[subnet["name"]] = ping_stats(
            gateway, count=diag_cfg.get("gateway_ping_count", 8)
        )

    target = diag_cfg.get("double_nat_probe_target", "1.1.1.1")
    note(f"tracing route to {target} to check for double-NAT")
    results["double_nat"] = check_double_nat(target)

    iso_cfg = diag_cfg.get("isolation_test", {})
    iso_target = iso_cfg.get("trusted_to_iot_target")
    if iso_target:
        note(f"checking local (trusted->IoT) reachability to {iso_target}")
        results["isolation_local"] = check_local_isolation(iso_target)

    results["isolation_remote"] = get_remote_isolation_report()
    if results["isolation_remote"] is None:
        note("no remote isolation report yet - run iot_probe.py from a "
             "device on the IoT subnet for the real bidirectional result")

    return results
