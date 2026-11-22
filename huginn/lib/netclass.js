// Address helpers. Pure.

function isPrivate(ip) {
  if (!ip) return false;
  if (ip.includes(":")) {
    const l = ip.toLowerCase();
    return l.startsWith("fe80") || l.startsWith("fc") || l.startsWith("fd") || l === "::1";
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
         (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

function isCast(ip) {
  if (!ip) return false;
  if (ip.includes(":")) return ip.toLowerCase().startsWith("ff");
  const a = Number(ip.split(".")[0]);
  return (a >= 224 && a <= 239) || ip === "255.255.255.255" || ip.endsWith(".255");
}

// Well-known ports, named for people.
const PORTS = {
  20: "FTP", 21: "FTP", 22: "SSH", 23: "Telnet", 25: "Mail", 53: "DNS", 67: "DHCP", 68: "DHCP",
  80: "Web", 123: "Time", 137: "Windows names", 138: "Windows names", 139: "Windows files",
  443: "Web (secure)", 445: "Windows files", 465: "Mail", 587: "Mail", 993: "Mail", 1900: "Device discovery",
  3074: "Xbox Live", 3389: "Remote desktop", 3478: "Calls / voice", 5353: "Device discovery",
  5355: "Windows names", 8080: "Web", 8443: "Web (secure)", 41641: "Tailscale",
};

function portName(port, proto) {
  if (proto === "udp" && port === 443) return "QUIC (fast web)";
  if (PORTS[port]) return PORTS[port];
  if (proto === "udp" && port >= 50000 && port <= 65535) return "Voice / game";
  if (port >= 27000 && port <= 27100) return "Steam";
  return null;
}

module.exports = { isPrivate, isCast, portName };
