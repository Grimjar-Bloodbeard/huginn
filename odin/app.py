"""
Odin's Watch - Flask backend.

Serves the dashboard, runs scans in a background thread (and every few minutes on its own),
streams progress over SSE for the live log panel, remembers every device it has seen
(known_devices.py), alerts the owner's phone about new ones, and reads the router (router.py).

Who gets in (2026-10-26):
  - Only home-network and Tailscale addresses. Anything else gets 403 before any route runs.
  - This PC (127.0.0.1) needs no login. Phones/laptops on the LAN or Tailscale sign in with the
    login in odin.auth.local.json (made on first run, gitignored, blocked for Claude sessions;
    ODIN_AUTH_USER / ODIN_AUTH_PASS env vars win if set).
  - Every POST needs the X-Odin header, which another website can't send, so a page you visit
    can't trigger scans or rename devices behind your back.
Never put this behind a public tunnel: the topology is a map of the whole home network.
"""

import base64
import hmac
import ipaddress
import json
import os
import queue
import secrets
import threading
import time
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_from_directory

import diagnostics
import known_devices
import router
import scanner

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.json"
TOPOLOGY_PATH = BASE_DIR / "network_topology.json"
LOGIN_PATH = BASE_DIR / "odin.auth.local.json"

app = Flask(__name__, static_folder=str(BASE_DIR / "static"), static_url_path="/static")

_state_lock = threading.Lock()
_scan_in_progress = False
_log_subscribers = []  # list of queue.Queue, one per connected SSE client
_latest_diagnostics = None
_latest_router = None

_ALLOWED_NETS = [ipaddress.ip_network(n) for n in (
    "127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
    "100.64.0.0/10",  # Tailscale
    "fd7a:115c:a1e0::/48",  # Tailscale IPv6
)]


def load_config():
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


def _login_creds():
    if os.environ.get("ODIN_AUTH_USER") and os.environ.get("ODIN_AUTH_PASS"):
        return os.environ["ODIN_AUTH_USER"], os.environ["ODIN_AUTH_PASS"]
    try:
        d = json.loads(LOGIN_PATH.read_text(encoding="utf-8"))
        return d["user"], d["pass"]
    except Exception:
        creds = {"user": "admin", "pass": secrets.token_urlsafe(12)}
        LOGIN_PATH.write_text(json.dumps(creds, indent=1), encoding="utf-8")
        return creds["user"], creds["pass"]


LOGIN = _login_creds()


def _client_ip():
    try:
        return ipaddress.ip_address((request.remote_addr or "").split("%")[0])
    except ValueError:
        return None


def _login_ok():
    header = request.headers.get("Authorization", "")
    if not header.startswith("Basic "):
        return False
    try:
        user, _, pw = base64.b64decode(header[6:]).decode("utf-8").partition(":")
    except Exception:
        return False
    return hmac.compare_digest(user, LOGIN[0]) and hmac.compare_digest(pw, LOGIN[1])


@app.before_request
def gate():
    ip = _client_ip()
    if ip is None or not any(ip in n for n in _ALLOWED_NETS):
        return Response("Home network or Tailscale only.\n", 403)
    if request.method == "POST" and request.path != "/api/isolation-report" and request.headers.get("X-Odin") != "1":
        return jsonify({"error": "Use the Odin's Watch page."}), 403
    # iot_probe.py posts from a gadget on the IoT network and can't log in; it only records a report.
    if ip.is_loopback or request.path == "/api/isolation-report":
        return None
    if not _login_ok():
        return Response("Sign in.\n", 401, {"WWW-Authenticate": 'Basic realm="Odin\'s Watch"'})
    return None


def broadcast_log(message):
    line = {"time": time.time(), "message": message}
    with _state_lock:
        subscribers = list(_log_subscribers)
    for q in subscribers:
        q.put(line)


def save_topology(devices, config, router_info):
    payload = {
        "generated_at": time.time(),
        "subnets": config["subnets"],
        "devices": devices,
        "router_networks": (router_info or {}).get("networks", []),
    }
    with open(TOPOLOGY_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    return payload


def read_router(config):
    """Read-only router snapshot, or None. Never raises; logs a short reason."""
    global _latest_router
    if not router.configured():
        _latest_router = {"configured": False}
        return None
    gateway = config["subnets"][0].get("gateway")
    try:
        snap = router.snapshot(gateway)
        _latest_router = {"configured": True, "ok": True, "at": time.time(), "user": snap["user"],
                          "networks": snap["networks"], "leases": len(snap["leases"]),
                          "reservations": len(snap["reservations"]),
                          "worked": snap["worked"], "failed": snap["failed"]}
        broadcast_log(f"router: {len(snap['networks'])} network(s), {len(snap['leases'])} lease(s)")
        return snap
    except router.RouterError as exc:
        _latest_router = {"configured": True, "ok": False, "at": time.time(), "error": str(exc)}
        broadcast_log(f"router: {exc}")
        return None


def run_scan_job():
    global _scan_in_progress, _latest_diagnostics
    with _state_lock:
        if _scan_in_progress:
            return
        _scan_in_progress = True

    try:
        config = load_config()
        broadcast_log("=== rescan triggered ===")
        scanned = scanner.scan_all(config, on_progress=broadcast_log)
        snap = read_router(config)
        devices, new = known_devices.merge(scanned, leases=(snap or {}).get("leases"))
        save_topology(devices, config, snap)
        broadcast_log(f"topology saved: {len(scanned)} online, {len(devices)} known, {len(new)} new")
        if new:
            known_devices.alert_new(new)
            broadcast_log(f"phone alert sent for {len(new)} new device(s)")

        broadcast_log("=== running diagnostics ===")
        _latest_diagnostics = diagnostics.run_full_diagnostics(config)
        for line in _latest_diagnostics.get("log", []):
            broadcast_log(line)
        broadcast_log("=== diagnostics complete ===")
    except Exception as exc:
        broadcast_log(f"ERROR during scan: {exc}")
    finally:
        with _state_lock:
            _scan_in_progress = False


@app.route("/")
def index():
    return send_from_directory(str(BASE_DIR / "static"), "index.html")


@app.route("/api/topology")
def api_topology():
    if TOPOLOGY_PATH.exists():
        with open(TOPOLOGY_PATH, encoding="utf-8") as f:
            return jsonify(json.load(f))
    return jsonify({"generated_at": None, "subnets": load_config()["subnets"], "devices": []})


@app.route("/api/rescan", methods=["POST"])
def api_rescan():
    with _state_lock:
        busy = _scan_in_progress
    if busy:
        return jsonify({"status": "already_running"}), 202
    threading.Thread(target=run_scan_job, daemon=True).start()
    return jsonify({"status": "started"}), 202


@app.route("/api/devices/label", methods=["POST"])
def api_label():
    body = request.get_json(force=True, silent=True) or {}
    if not known_devices.set_label(body.get("mac"), body.get("label")):
        return jsonify({"error": "unknown device"}), 404
    # Keep the saved topology in step so the page shows the new name without a rescan.
    if TOPOLOGY_PATH.exists():
        topo = json.loads(TOPOLOGY_PATH.read_text(encoding="utf-8"))
        for d in topo.get("devices", []):
            if d.get("mac") == (body.get("mac") or "").upper():
                d["label"] = (body.get("label") or "").strip()[:60] or None
        TOPOLOGY_PATH.write_text(json.dumps(topo, indent=2), encoding="utf-8")
    return jsonify({"status": "saved"})


@app.route("/api/router")
def api_router():
    return jsonify(_latest_router or {"configured": router.configured(), "note": "not read yet, trigger a rescan"})


@app.route("/api/diagnostics")
def api_diagnostics():
    return jsonify(_latest_diagnostics or {"note": "no diagnostics run yet, trigger a rescan"})


@app.route("/api/isolation-report", methods=["POST"])
def api_isolation_report():
    report = request.get_json(force=True, silent=True)
    if not report:
        return jsonify({"error": "invalid or missing JSON body"}), 400
    stored = diagnostics.record_remote_isolation_report(report)
    broadcast_log(
        f"remote isolation report received: "
        f"{'LEAK DETECTED' if report.get('any_target_reachable') else 'isolation holds'} "
        f"from {report.get('probe_host_platform', 'unknown host')}"
    )
    return jsonify({"status": "recorded", "report": stored})


@app.route("/api/events")
def api_events():
    def stream():
        q = queue.Queue()
        with _state_lock:
            _log_subscribers.append(q)
        try:
            yield "data: " + json.dumps({"time": time.time(), "message": "connected to log stream"}) + "\n\n"
            while True:
                line = q.get()
                yield f"data: {json.dumps(line)}\n\n"
        finally:
            with _state_lock:
                if q in _log_subscribers:
                    _log_subscribers.remove(q)

    return Response(stream(), mimetype="text/event-stream")


def start_auto_rescan(config):
    minutes = config.get("scan", {}).get("auto_rescan_minutes", 0)
    if not minutes:
        return

    def loop():
        time.sleep(5)  # first scan right after start, so memory and alerts are live at once
        while True:
            run_scan_job()
            time.sleep(minutes * 60)

    threading.Thread(target=loop, daemon=True).start()


if __name__ == "__main__":
    cfg = load_config()
    start_auto_rescan(cfg)

    server_cfg = cfg.get("server", {})
    host = os.environ.get("ODIN_HOST") or server_cfg.get("host", "0.0.0.0")
    port = int(os.environ.get("ODIN_PORT") or server_cfg.get("port", 7331))

    print(f"Odin's Watch on http://{host}:{port} (this PC needs no login; other devices use odin.auth.local.json)")
    app.run(host=host, port=port, threaded=True)
