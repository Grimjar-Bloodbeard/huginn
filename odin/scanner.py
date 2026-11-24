"""
Odin's Watch - network discovery core.

Default path is pure stdlib: ping-sweep to populate the OS ARP cache, then
parse `arp -a`. That needs no admin rights and no extra installs. If scapy
is imported successfully AND the process is running elevated, an ARP
who-has sweep is used instead - faster, and it catches devices that drop
ICMP but still answer ARP (a lot of IoT gear does this).
"""

import ipaddress
import json
import platform
import re
import socket
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

IS_WINDOWS = platform.system() == "Windows"
BASE_DIR = Path(__file__).resolve().parent

_OUI_CACHE = None


def load_oui_db():
    global _OUI_CACHE
    if _OUI_CACHE is None:
        oui_path = BASE_DIR / "oui_vendors.json"
        with open(oui_path, encoding="utf-8") as f:
            _OUI_CACHE = json.load(f)
    return _OUI_CACHE


def vendor_for_mac(mac):
    if not mac:
        return None
    prefix = mac.upper().replace(":", "").replace("-", "")[:6]
    return load_oui_db().get(prefix)


def is_elevated():
    if not IS_WINDOWS:
        return False
    try:
        import ctypes
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def scapy_available():
    try:
        import scapy.all  # noqa: F401
        return True
    except Exception:
        return False


def _ping_once(ip, timeout_ms):
    if IS_WINDOWS:
        cmd = ["ping", "-n", "1", "-w", str(timeout_ms), str(ip)]
    else:
        cmd = ["ping", "-c", "1", "-W", str(max(1, timeout_ms // 1000)), str(ip)]
    try:
        result = subprocess.run(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=(timeout_ms / 1000) + 1.5,
        )
        # TTL= only appears on a real reply; Windows exits 0 on a router's "unreachable" too
        return result.returncode == 0 and "ttl=" in result.stdout.decode(errors="ignore").lower()
    except Exception:
        return False


def ping_sweep(cidr, timeout_ms=500, concurrency=64, on_progress=None):
    """Ping every host in cidr concurrently. Returns set of responding IPs.

    A ping-only sweep misses hosts that block ICMP, so this is a
    best-effort pass meant to warm the ARP cache, not the final device list.
    """
    network = ipaddress.ip_network(cidr, strict=False)
    hosts = [str(h) for h in network.hosts()]
    alive = set()

    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {pool.submit(_ping_once, ip, timeout_ms): ip for ip in hosts}
        done = 0
        for fut in as_completed(futures):
            ip = futures[fut]
            done += 1
            if fut.result():
                alive.add(ip)
                if on_progress:
                    on_progress(f"host {ip} responded to ping ({done}/{len(hosts)})")
    return alive


_ARP_LINE_WIN = re.compile(
    r"(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-fA-F]{2}(?:-[0-9a-fA-F]{2}){5})"
)
_ARP_LINE_POSIX = re.compile(
    r"\(?(\d{1,3}(?:\.\d{1,3}){3})\)?\s+at\s+([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})"
)


_BAD_MACS = ("FF:FF:FF:FF:FF:FF", "00:00:00:00:00:00")


def parse_proc_net_arp(text):
    """Linux kernel ARP cache (/proc/net/arp). Flags 0x0 means the entry never completed."""
    table = {}
    for line in text.splitlines()[1:]:
        cols = line.split()
        if len(cols) < 4 or cols[2] == "0x0":
            continue
        ip, mac = cols[0], cols[3].upper()
        if re.fullmatch(r"[0-9A-F]{2}(:[0-9A-F]{2}){5}", mac) and mac not in _BAD_MACS:
            table[ip] = mac
    return table


_IP_NEIGH_LINE = re.compile(
    r"^(\d{1,3}(?:\.\d{1,3}){3})\s.*\blladdr\s+([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})"
)


def parse_ip_neigh(text):
    """`ip neigh` output: 192.168.1.1 dev wlan0 lladdr aa:bb:cc:dd:ee:ff REACHABLE"""
    table = {}
    for line in text.splitlines():
        line = line.strip()
        m = _IP_NEIGH_LINE.search(line)
        if m and "FAILED" not in line and "INCOMPLETE" not in line:
            mac = m.group(2).upper()
            if mac not in _BAD_MACS:
                table[m.group(1)] = mac
    return table


def _read_arp_linux_fallbacks():
    """Modern distros often lack `arp` (net-tools). Ask the kernel, then iproute2."""
    try:
        with open("/proc/net/arp", encoding="utf-8", errors="ignore") as f:
            table = parse_proc_net_arp(f.read())
        if table:
            return table
    except Exception:
        pass   # newer Android (Termux) blocks this file
    try:
        out = subprocess.run(["ip", "neigh"], stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, timeout=10).stdout.decode(errors="ignore")
        return parse_ip_neigh(out)
    except Exception:
        return {}


def ping_only_hosts(arp_table, alive, network):
    """Hosts to list by address alone. Only used when the ARP table came back completely empty
    (Android hides it from apps), so a working ARP table never gets MAC-less duplicates."""
    if arp_table:
        return []
    return sorted((ip for ip in (alive or ()) if ipaddress.ip_address(ip) in network),
                  key=lambda ip: tuple(map(int, ip.split("."))))


def read_arp_table():
    """Parse the OS ARP cache into {ip: mac (colon form, uppercase)}."""
    try:
        output = subprocess.run(
            ["arp", "-a"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=10,
        ).stdout.decode(errors="ignore")
    except Exception:
        if IS_WINDOWS:
            return {}
        output = ""
    if not IS_WINDOWS and not _ARP_LINE_POSIX.search(output):
        return _read_arp_linux_fallbacks()

    table = {}
    pattern = _ARP_LINE_WIN if IS_WINDOWS else _ARP_LINE_POSIX
    for line in output.splitlines():
        m = pattern.search(line)
        if m:
            ip, mac = m.group(1), m.group(2)
            mac = mac.replace("-", ":").upper()
            if mac not in ("FF:FF:FF:FF:FF:FF", "00:00:00:00:00:00"):
                table[ip] = mac
    return table


def scapy_arp_sweep(cidr, timeout=3, on_progress=None):
    """Active ARP who-has sweep via scapy. Requires admin + npcap."""
    from scapy.all import ARP, Ether, srp

    if on_progress:
        on_progress(f"sending raw ARP requests across {cidr} (elevated mode)")

    request = Ether(dst="ff:ff:ff:ff:ff:ff") / ARP(pdst=cidr)
    answered, _ = srp(request, timeout=timeout, verbose=0)

    table = {}
    for _, received in answered:
        table[received.psrc] = received.hwsrc.upper()
        if on_progress:
            on_progress(f"ARP reply from {received.psrc} ({received.hwsrc.upper()})")
    return table


_MDNS_SERVICE_TYPES = [
    "_http._tcp.local.", "_device-info._tcp.local.", "_workstation._tcp.local.",
    "_googlecast._tcp.local.", "_airplay._tcp.local.", "_raop._tcp.local.",
    "_spotify-connect._tcp.local.", "_ipp._tcp.local.", "_hap._tcp.local.",
    "_printer._tcp.local.", "_smb._tcp.local.",
]


def mdns_discover(timeout=3.0):
    """Browse common mDNS service types once and return {ip: hostname}.

    mDNS has no generic reverse-IP query like DNS PTR; the real-world way
    to map IP->name is to listen for services being advertised and read
    the hostname off whichever ones respond. Runs once per scan pass,
    not per device.
    """
    try:
        from zeroconf import Zeroconf, ServiceBrowser, ServiceListener
    except ImportError:
        return {}

    found = {}

    class _Listener(ServiceListener):
        def add_service(self, zc, type_, name):
            try:
                info = zc.get_service_info(type_, name, timeout=1000)
            except Exception:
                return
            if not info or not info.server:
                return
            hostname = info.server.rstrip(".")
            for addr in info.parsed_scoped_addresses():
                found.setdefault(addr, hostname)

        def update_service(self, zc, type_, name):
            pass

        def remove_service(self, zc, type_, name):
            pass

    zc = Zeroconf()
    try:
        ServiceBrowser(zc, _MDNS_SERVICE_TYPES, _Listener())
        time.sleep(timeout)
    finally:
        zc.close()
    return found


def resolve_hostname(ip, mdns_table=None):
    try:
        name = socket.gethostbyaddr(ip)[0]
        if name and name != ip:
            return name
    except Exception:
        pass
    if mdns_table:
        return mdns_table.get(ip)
    return None


def check_ports(ip, ports, timeout_ms=400):
    open_ports = []

    def _check(port):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(timeout_ms / 1000)
            try:
                if s.connect_ex((ip, port)) == 0:
                    return port
            except Exception:
                return None
        return None

    with ThreadPoolExecutor(max_workers=min(16, len(ports) or 1)) as pool:
        for result in pool.map(_check, ports):
            if result:
                open_ports.append(result)
    return sorted(open_ports)


_IOT_VENDOR_HINTS = (
    "espressif", "sonos", "tuya", "roborock", "ecobee", "philips lighting",
    "signify", "wyze", "ring", "nest", "ecovacs", "belkin", "tp-link",
    "shenzhen", "xiaomi", "amazon technologies", "google, inc", "google llc",
)
_PC_VENDOR_HINTS = (
    "dell", "intel corporate", "hewlett packard", "lenovo", "asustek",
    "micro-star", "gigabyte", "azurewave", "realtek",
)
_CONSOLE_VENDOR_HINTS = (
    "sony interactive", "microsoft corporation", "nintendo",
)
_MOBILE_VENDOR_HINTS = ("apple, inc", "samsung electr")


def classify_device(ip, mac, vendor, hostname, open_ports, gateway_ips):
    vendor_l = (vendor or "").lower()
    hostname_l = (hostname or "").lower()

    if ip in gateway_ips:
        return "router"
    if any(h in vendor_l for h in _CONSOLE_VENDOR_HINTS):
        return "console"
    if any(h in vendor_l for h in _MOBILE_VENDOR_HINTS):
        return "mobile"
    if any(h in vendor_l for h in _PC_VENDOR_HINTS) or 3389 in open_ports or 445 in open_ports:
        return "pc"
    if any(h in vendor_l for h in _IOT_VENDOR_HINTS):
        return "iot"
    if "raspberry pi" in vendor_l:
        return "pc"
    if open_ports and (80 in open_ports or 443 in open_ports or 8080 in open_ports):
        return "iot"
    return "unknown"


def scan_subnet(subnet_cfg, scan_cfg, on_progress=None):
    """Run a full discovery pass for one configured subnet.

    Returns a list of device dicts. on_progress(str) is called for each
    notable event, meant to feed a live log panel.
    """
    def log(msg):
        if on_progress:
            on_progress(msg)

    cidr = subnet_cfg["cidr"]
    log(f"scan started on {subnet_cfg['name']} ({cidr})")

    use_scapy = (
        scan_cfg.get("prefer_scapy_if_elevated", True)
        and scapy_available()
        and is_elevated()
    )

    ping_only = []
    if use_scapy:
        arp_table = scapy_arp_sweep(cidr, on_progress=log)
    else:
        log(f"ping-sweeping {cidr} (timeout {scan_cfg.get('ping_timeout_ms', 500)}ms/host)")
        alive = ping_sweep(
            cidr,
            timeout_ms=scan_cfg.get("ping_timeout_ms", 500),
            concurrency=scan_cfg.get("ping_concurrency", 64),
            on_progress=log,
        )
        log("reading OS ARP cache")
        arp_table = read_arp_table()
        network = ipaddress.ip_network(cidr, strict=False)
        arp_table = {ip: mac for ip, mac in arp_table.items()
                     if ipaddress.ip_address(ip) in network}
        ping_only = ping_only_hosts(arp_table, alive, network)
        if ping_only:
            log("this system won't share its ARP table (normal on Android), so devices that "
                "answered the ping are listed by address only, without a hardware ID")

    log(f"{len(arp_table) + len(ping_only)} device(s) found on {subnet_cfg['name']}")

    ports = scan_cfg.get("ports_to_check", [22, 80, 443, 8080])
    port_timeout = scan_cfg.get("port_check_timeout_ms", 400)
    gateway_ips = {s.get("gateway") for s in [subnet_cfg]}

    mdns_table = {}
    if scan_cfg.get("resolve_mdns", True):
        log("browsing mDNS for hostnames (mDNS is link-local; only resolves "
            "on the subnet this host is physically attached to)")
        mdns_table = mdns_discover(timeout=3.0)

    devices = []
    found = list(arp_table.items()) + [(ip, None) for ip in ping_only]
    for ip, mac in sorted(found, key=lambda kv: tuple(map(int, kv[0].split(".")))):
        vendor = vendor_for_mac(mac)
        hostname = resolve_hostname(ip, mdns_table=mdns_table)
        open_ports = check_ports(ip, ports, timeout_ms=port_timeout)
        device_type = classify_device(ip, mac, vendor, hostname, open_ports, gateway_ips)

        log(f"{ip} -> {mac or 'no hardware ID'}  {vendor or 'unknown vendor'}  "
            f"[{device_type}]  ports={open_ports or 'none'}")

        devices.append({
            "ip": ip,
            "mac": mac,
            "vendor": vendor,
            "hostname": hostname,
            "open_ports": open_ports,
            "device_type": device_type,
            "subnet": subnet_cfg["name"],
            "role": subnet_cfg["role"],
            "status": "online",
            "last_seen": time.time(),
        })

    log(f"scan complete on {subnet_cfg['name']}: {len(devices)} device(s)")
    return devices


def scan_all(config, on_progress=None):
    all_devices = []
    for subnet_cfg in config["subnets"]:
        all_devices.extend(scan_subnet(subnet_cfg, config["scan"], on_progress=on_progress))
    return all_devices
