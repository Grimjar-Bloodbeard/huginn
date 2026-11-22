"""
Odin's Watch - read-only link to the Cudy router (2026-10-26).

The Cudy WR3000P's stock firmware is OpenWrt/LuCI underneath and answers OpenWrt's
program interface (JSON-RPC at http://<gateway>/ubus). After signing in with the router's
admin password this reads what the router knows: its networks (main, guest, ...), DHCP
leases (names devices gave the router) and address reservations.

READ-ONLY on purpose: nothing here changes a router setting. Editing comes later and will use
OpenWrt's apply-with-rollback so a bad change undoes itself.

The password lives in router.local.json next to this file. the owner fills it in with
set-router-password.ps1 (hidden typing), it is gitignored, and Claude sessions are blocked
from opening it. It is never logged, printed or returned by the API.
"""

import json
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
SECRET_PATH = BASE_DIR / "router.local.json"
NULL_SESSION = "0" * 32
# Option names that hold secrets in OpenWrt configs; stripped from anything we keep.
_SECRET_KEYS = {"key", "password", "psk", "sae_password", "auth_secret", "acct_secret", "priv_key"}


class RouterError(Exception):
    pass


def configured():
    return SECRET_PATH.exists()


def _load_secret():
    try:
        data = json.loads(SECRET_PATH.read_text(encoding="utf-8-sig"))
    except Exception:
        raise RouterError("router password file is missing or unreadable; run set-router-password.ps1")
    if not data.get("password"):
        raise RouterError("router password file has no password; run set-router-password.ps1")
    return data


def _rpc(gateway, params, timeout=6):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "call", "params": params}).encode()
    req = urllib.request.Request(f"http://{gateway}/ubus", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        out = json.loads(resp.read().decode("utf-8", "replace"))
    res = out.get("result")
    if not isinstance(res, list) or not res:
        err = out.get("error") or {}
        return f"rpc {err.get('code')}: {err.get('message')}", None
    return res[0], (res[1] if len(res) > 1 else None)


def _scrub(obj):
    if isinstance(obj, dict):
        return {k: _scrub(v) for k, v in obj.items() if k.lower() not in _SECRET_KEYS}
    if isinstance(obj, list):
        return [_scrub(v) for v in obj]
    return obj


def _login(gateway, secret):
    users = [secret["username"]] if secret.get("username") else ["admin", "root"]
    for user in users:
        try:
            code, data = _rpc(gateway, [NULL_SESSION, "session", "login",
                                        {"username": user, "password": secret["password"], "timeout": 300}])
        except Exception as exc:
            raise RouterError(f"couldn't reach the router at {gateway} ({type(exc).__name__})")
        if code == 0 and data and data.get("ubus_rpc_session"):
            return data["ubus_rpc_session"], user
    raise RouterError("router refused the sign-in (wrong password, or this firmware wants another user name)")


def snapshot(gateway):
    """Sign in, read what we can, sign out. Returns a dict; never contains the password."""
    secret = _load_secret()
    sid, user = _login(gateway, secret)
    result = {"gateway": gateway, "user": user, "worked": [], "failed": [],
              "networks": [], "leases": [], "reservations": []}

    def call(obj, method, args=None):
        try:
            code, data = _rpc(gateway, [sid, obj, method, args or {}])
        except Exception as exc:
            result["failed"].append(f"{obj}.{method} ({type(exc).__name__})")
            return None
        if code != 0:
            result["failed"].append(f"{obj}.{method} (code {code})")
            return None
        result["worked"].append(f"{obj}.{method}")
        return data

    try:
        dump = call("network.interface", "dump") or {}
        for itf in dump.get("interface", []):
            addrs = itf.get("ipv4-address") or []
            if not addrs or itf.get("interface") in ("loopback", "wan", "wan6"):
                continue
            a = addrs[0]
            result["networks"].append({"name": itf.get("interface"), "up": itf.get("up"),
                                       "address": a.get("address"), "mask": a.get("mask")})

        leases = None
        for obj, method in (("luci-rpc", "getDHCPLeases"), ("dhcp", "ipv4leases")):
            leases = call(obj, method)
            if leases:
                break
        for lease in (leases or {}).get("dhcp_leases", []) if isinstance(leases, dict) else []:
            result["leases"].append({"mac": (lease.get("macaddr") or "").upper(), "ip": lease.get("ipaddr"),
                                     "hostname": lease.get("hostname")})
        if not result["leases"]:
            raw = call("file", "read", {"path": "/tmp/dhcp.leases"})
            for line in ((raw or {}).get("data") or "").splitlines():
                parts = line.split()
                if len(parts) >= 4:
                    result["leases"].append({"mac": parts[1].upper(), "ip": parts[2],
                                             "hostname": None if parts[3] == "*" else parts[3]})

        dhcp_cfg = call("uci", "get", {"config": "dhcp"}) or {}
        for sec in (dhcp_cfg.get("values") or {}).values():
            if sec.get(".type") == "host":
                result["reservations"].append(_scrub({"name": sec.get("name"), "mac": sec.get("mac"),
                                                      "ip": sec.get("ip")}))
    finally:
        try:
            _rpc(gateway, [sid, "session", "destroy", {}])
        except Exception:
            pass
    if not result["worked"]:
        # Found 2026-10-26 on the Cudy WR3000P: session.login succeeds, every read after it is
        # "Access denied" (even session.access). Fall back to reading the router's web pages.
        web = web_clients(gateway)
        result["user"] = "admin (web page)"
        result["leases"] = web["clients"]
        result["worked"] = [f"web {p}" for p in web["pages"]]
        if not result["leases"]:
            raise RouterError("signed in, but no device list found on the router's pages yet; "
                              "run router.py --peek and share the output")
    return result


# --- The router's own web page (2026-10-26) ------------------------------------------------
# Cudy's login page hashes the password in the browser (luci-static/light/js/sysauth.js):
#   luci_password = sha256( sha256(password + salt) + token )
# with salt/token/_csrf taken from hidden fields on the login page. The result is a "sysauth"
# cookie. Read-only use only.
import hashlib
import http.cookiejar
import re
import urllib.error
import urllib.parse

_HIDDEN = re.compile(r'<input type="hidden" name="([^"]+)" class="form-control" value="([^"]*)"')


def web_session(gateway):
    secret = _load_secret()
    base = f"http://{gateway}"
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    try:
        page = opener.open(base + "/cgi-bin/luci", timeout=8).read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:  # the login page is served with a 403
        page = e.read().decode("utf-8", "replace")
    except Exception as exc:
        raise RouterError(f"couldn't reach the router at {gateway} ({type(exc).__name__})")
    form = dict(_HIDDEN.findall(page))
    if "salt" not in form or "token" not in form:
        raise RouterError("router login page changed (no salt/token); firmware update?")
    inner = hashlib.sha256((secret["password"] + form["salt"]).encode()).hexdigest()
    form["luci_password"] = hashlib.sha256((inner + form["token"]).encode()).hexdigest()
    form.setdefault("luci_username", secret.get("username") or "admin")
    opener.open(base + "/cgi-bin/luci/", data=urllib.parse.urlencode(form).encode(), timeout=8).read()
    if not any(c.name == "sysauth" for c in jar):
        raise RouterError("router refused the web sign-in (wrong password?)")

    def get(path):
        try:
            return opener.open(base + path, timeout=10).read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return f"HTTP {e.code}"
    return get


# Pages from the owner's --pages run (2026-10-26) most likely to list connected devices.
CLIENT_PAGES = [
    "/cgi-bin/luci/admin/network/devices/devlist",
    "/cgi-bin/luci/admin/services/dhcp/status",
    "/cgi-bin/luci/admin/network/devices/status",
    "/cgi-bin/luci/admin/network/devices",
    "/cgi-bin/luci/admin/network/arpbind",
]
_MAC = re.compile(r'\b([0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5})\b')
_IP4 = re.compile(r'\b((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})\b')
_TAG = re.compile(r'<[^>]+>')
_NOISE = re.compile(r'^(?:[-\d\s.:/%]+|online|offline|wired|wireless|2\.4g|5g|guest|lan|dhcp|static|'
                    r'block|edit|delete|unblock|limit|unlimited|kb/s|mb/s|n/a|-)$', re.I)


def _rows(html):
    """Split a page into chunks that each mention exactly one MAC (table rows or list items)."""
    html = re.sub(r'(?is)<script.*?</script>|<style.*?</style>', ' ', html)
    for sep in (r'(?i)</tr>', r'(?i)</li>', r'(?i)<div[^>]*class="[^"]*(?:row|item|card)[^"]*"'):
        chunks = [c for c in re.split(sep, html) if len(set(m.upper() for m in _MAC.findall(c))) == 1]
        if chunks:
            return chunks
    return []


def _cells(chunk):
    out = []
    for raw in _TAG.sub("\n", chunk).splitlines():
        t = " ".join(raw.replace("&nbsp;", " ").split())
        if t:
            out.append(t)
    return out


def parse_clients(html):
    """Best guess at [{mac, ip, hostname}] from one router page. Pure function, no network."""
    found = {}
    for chunk in _rows(html):
        mac = _MAC.search(chunk).group(1).upper().replace("-", ":")
        ips = _IP4.findall(_TAG.sub(" ", chunk))
        name = next((c for c in _cells(chunk)
                     if not _MAC.search(c) and not _IP4.search(c) and not _NOISE.match(c)
                     and 1 < len(c) <= 64), None)
        rec = found.setdefault(mac, {"mac": mac, "ip": None, "hostname": None})
        rec["ip"] = rec["ip"] or (ips[0] if ips else None)
        rec["hostname"] = rec["hostname"] or name
    return list(found.values())


def web_clients(gateway):
    """Connected devices from the router's own pages. Merged by MAC across pages."""
    get = web_session(gateway)
    merged, used = {}, []
    for path in CLIENT_PAGES:
        rows = parse_clients(get(path))
        if rows:
            used.append(path.rsplit("/admin/", 1)[-1])
        for r in rows:
            cur = merged.setdefault(r["mac"], r)
            cur["ip"] = cur["ip"] or r["ip"]
            cur["hostname"] = cur["hostname"] or r["hostname"]
    return {"clients": list(merged.values()), "pages": used}


def _mask(text):
    """Swap every MAC, IP and word for a placeholder so page shapes can be shared safely."""
    text = _MAC.sub("<MAC>", text)
    text = _IP4.sub("<IP>", text)
    keep = {"class", "id", "type", "colspan", "rowspan", "style"}
    text = re.sub(r'([\w-]+)=(["\'])(.*?)\2',
                  lambda m: m.group(0) if m.group(1).lower() in keep else f'{m.group(1)}="V{len(m.group(3))}"', text)
    return re.sub(r'>([^<]+)<', lambda m: ">" + (f"T{len(m.group(1).strip())}" if m.group(1).strip() else "") + "<", text)


def peek(gateway):
    """Masked summary of each client page: sizes, counts, data URLs, one masked row."""
    get = web_session(gateway)
    for path in CLIENT_PAGES:
        html = get(path)
        print(f"\n== {path.rsplit('/admin/', 1)[-1]}  ({len(html)} chars)")
        if html.startswith("HTTP "):
            print("  ", html)
            continue
        macs = {m.upper() for m in _MAC.findall(html)}
        print(f"   macs={len(macs)} ips={len(set(_IP4.findall(html)))} rows<tr>={html.lower().count('<tr')}"
              f" parsed={len(parse_clients(html))}")
        for u in sorted(set(re.findall(r'["\'](/cgi-bin/luci/[^"\'?\s]+)', html)))[:15]:
            print("   url:", u)
        rows = _rows(html)
        if rows:
            sample = re.sub(r'\s+', ' ', _mask(rows[0]))[:600]
            print("   row:", sample)


def list_pages(gateway, depth=2):
    """Admin page paths reachable after sign-in (names only, no page content)."""
    get = web_session(gateway)
    found, frontier = set(), ["/cgi-bin/luci/"]
    for _ in range(depth + 1):
        nxt = []
        for p in frontier:
            for u in re.findall(r'(/cgi-bin/luci/admin/[A-Za-z0-9_/\-]+)', get(p)):
                if u not in found and "logout" not in u:
                    found.add(u)
                    nxt.append(u)
        frontier = nxt[:60]
    return sorted(found)


if __name__ == "__main__":
    # Manual check: python router.py [gateway]. Prints counts and which calls worked, no device details.
    import sys
    if "--pages" in sys.argv:
        # python router.py --pages : list the router's admin pages (names only) for Claude to pick from
        try:
            for p in list_pages("192.168.1.1"):
                print(p)
        except RouterError as e:
            print("router:", e)
        sys.exit(0)
    if "--peek" in sys.argv:
        # python router.py --peek : page shapes with every name/IP/MAC masked, safe to paste
        try:
            peek("192.168.1.1")
        except RouterError as e:
            print("router:", e)
        sys.exit(0)
    if "--devices" in sys.argv:
        # python router.py --devices : how many devices the web reader found (counts only)
        try:
            w = web_clients("192.168.1.1")
            named = sum(1 for c in w["clients"] if c["hostname"])
            print(f"devices: {len(w['clients'])}  with names: {named}  pages: {', '.join(w['pages']) or 'none'}")
        except RouterError as e:
            print("router:", e)
        sys.exit(0)
    gw = sys.argv[1] if len(sys.argv) > 1 else "192.168.1.1"
    try:
        s = snapshot(gw)
        print(f"signed in as '{s['user']}'")
        print("networks:", ", ".join(f"{n['name']}={n['address']}/{n['mask']}" for n in s["networks"]) or "none")
        print(f"leases: {len(s['leases'])}  reservations: {len(s['reservations'])}")
        print("worked:", ", ".join(s["worked"]) or "nothing")
        print("failed:", ", ".join(s["failed"]) or "nothing")
    except RouterError as e:
        print("router:", e)
        sys.exit(1)
