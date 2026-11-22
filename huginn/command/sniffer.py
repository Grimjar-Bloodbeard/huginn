"""
Huginn packet eyes: watches this PC's network card and prints one compact JSON
line per packet on stdout for the command center (server.js) to read.

Read-only. Nothing is saved to disk; packets live only in memory on the way
through. Needs Npcap (installed, admin-only mode off), not admin rights.

Line shapes:
  {"p": [t, src, dst, proto, sport, dport, length]}   a packet
  {"dns": name, "ips": [...], "c": client_ip}         a DNS answer seen
  {"sni": name, "ip": server_ip}                       a TLS server name seen
  {"iface": name, "ips": [...]}                        once, at start
"""

import json
import sys
import threading
import time

from scapy.all import conf, sniff, get_if_addr  # noqa: E402
from scapy.layers.dns import DNS
from scapy.layers.inet import IP, TCP, UDP, ICMP
from scapy.layers.inet6 import IPv6

out = sys.stdout
lock = threading.Lock()
buf = []


def emit(obj):
    with lock:
        buf.append(json.dumps(obj, separators=(",", ":")))


def flusher():
    # Batch writes so a busy network doesn't mean thousands of syscalls a second.
    while True:
        time.sleep(0.05)
        with lock:
            if not buf:
                continue
            chunk = "\n".join(buf) + "\n"
            buf.clear()
        try:
            out.write(chunk)
            out.flush()
        except (BrokenPipeError, OSError):
            sys.exit(0)


def sni_from_client_hello(data):
    """Server name from a TLS ClientHello, or None. Only reads the clear-text header."""
    try:
        if len(data) < 43 or data[0] != 0x16 or data[5] != 0x01:
            return None
        i = 43                                   # record(5) + handshake(4) + version(2) + random(32)
        i += 1 + data[i]                         # session id
        i += 2 + int.from_bytes(data[i:i + 2], "big")   # cipher suites
        i += 1 + data[i]                         # compression
        end = i + 2 + int.from_bytes(data[i:i + 2], "big")
        i += 2
        while i + 4 <= min(end, len(data)):
            etype = int.from_bytes(data[i:i + 2], "big")
            elen = int.from_bytes(data[i + 2:i + 4], "big")
            if etype == 0:                       # server_name
                n = int.from_bytes(data[i + 7:i + 9], "big")
                return data[i + 9:i + 9 + n].decode("ascii", "ignore") or None
            i += 4 + elen
    except (IndexError, ValueError):
        return None
    return None


def on_packet(pkt):
    if IP in pkt:
        ip = pkt[IP]
        src, dst, length = ip.src, ip.dst, ip.len
    elif IPv6 in pkt:
        ip = pkt[IPv6]
        src, dst, length = ip.src, ip.dst, ip.plen + 40
    else:
        return

    sport = dport = 0
    if TCP in pkt:
        proto, sport, dport = "tcp", pkt[TCP].sport, pkt[TCP].dport
        if dport == 443:
            payload = bytes(pkt[TCP].payload)
            if payload[:1] == b"\x16":
                name = sni_from_client_hello(payload)
                if name:
                    emit({"sni": name, "ip": dst})
    elif UDP in pkt:
        proto, sport, dport = "udp", pkt[UDP].sport, pkt[UDP].dport
    elif ICMP in pkt or getattr(ip, "nh", None) == 58:
        proto = "icmp"
    else:
        proto = "other"

    emit({"p": [round(pkt.time, 3), src, dst, proto, sport, dport, int(length)]})

    if proto == "udp" and sport == 53 and DNS in pkt:
        dns = pkt[DNS]
        if dns.qr == 1 and dns.ancount and dns.qd:
            qname = dns.qd.qname.decode("ascii", "ignore").rstrip(".")
            ips = []
            for i in range(dns.ancount):
                rr = dns.an[i]
                if getattr(rr, "type", 0) in (1, 28):
                    ips.append(str(rr.rdata))
            if ips:
                emit({"dns": qname, "ips": ips, "c": dst})


def main():
    iface = conf.iface
    name = getattr(iface, "name", str(iface))
    ips = [a for a in {get_if_addr(iface)} if a and a != "0.0.0.0"]
    emit({"iface": name, "ips": ips})
    threading.Thread(target=flusher, daemon=True).start()
    # Do NOT enter promiscuous mode: we only want this host's own traffic (plus the
    # broadcast/multicast it already receives), never other machines' packets. This keeps
    # the footprint minimal and avoids the promiscuous-mode flag that network monitors raise.
    conf.promisc = False
    conf.sniff_promisc = False
    sniff(iface=iface, prn=on_packet, store=False, filter="ip or ip6", promisc=False)


if __name__ == "__main__":
    main()
