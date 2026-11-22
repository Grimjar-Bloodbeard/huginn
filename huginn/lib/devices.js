// What kind of thing each device is (for its icon), and the small checks behind renaming.
// Pure, so it can be tested.

const ICONS = ["phone", "tablet", "computer", "laptop", "tv", "console", "speaker", "camera",
               "plug", "chip", "printer", "router", "server", "watch", "unknown"];

const RULES = [
  ["router",  /router|access point|\bap\b|mesh|deco|eero|cudy|repeater|extender/],
  ["server",  /reliable|server|nas|synology|raspberry|pi-hole|pihole|proxmox|unraid/],
  ["console", /playstation|\bps[45]\b|xbox|nintendo|switch|steam ?deck|sony interactive/],
  ["tv",      /\btv\b|roku|chromecast|fire ?tv|firestick|bravia|vizio|hisense|tcl|lg ?web|google ?tv|shield|apple ?tv/],
  ["speaker", /nest|home[- ]mini|home[- ]hub|echo|alexa|sonos|homepod|speaker/],
  ["camera",  /cam|ring|wyze|blink|arlo|eufy|doorbell/],
  ["printer", /print|epson|brother|canon|hp ?inc/],
  ["watch",   /watch|fitbit|garmin/],
  ["tablet",  /\btab\b|tablet|ipad|kindle|-tab-|paperwhite/],
  ["phone",   /phone|iphone|galaxy|\bs2\d\b|pixel|motorola|moto|oneplus|android|samsung|xiaomi/],
  ["laptop",  /laptop|macbook|notebook|chromebook|thinkpad/],
  ["computer",/desktop|\bpc\b|imac|windows|micro-star|msi|asus|gigabyte|dell|lenovo|-rig\b/],
  ["plug",    /plug|tuya|kasa|meross|shelly|sonoff|smart ?life|tp-link|wemo|switch/],
];

// Best guess from what Odin's Watch knows. `type` is Odin's device_type.
function guessIcon(d = {}) {
  const text = [d.name, d.hostname, d.vendor].filter(Boolean).join(" ").toLowerCase();
  if (d.type === "router") return "router";
  if (d.type === "console") return "console";
  for (const [icon, re] of RULES) if (re.test(text)) return icon;
  if (d.type === "pc") return "computer";
  if (d.type === "iot") return "chip";
  return "unknown";
}

const MAC = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;

// Validates a rename request. Returns { ok, mac, label, icon } or { ok: false, error }.
function checkRename(body) {
  if (!body || typeof body !== "object") return { ok: false, error: "No details sent." };
  const mac = String(body.mac || "").toUpperCase();
  if (!MAC.test(mac)) return { ok: false, error: "That isn't a device Huginn knows." };
  let label = body.label == null ? null : String(body.label);
  if (label != null) {
    label = label.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 60);
  }
  const icon = body.icon == null ? null : String(body.icon);
  if (icon != null && !ICONS.includes(icon)) return { ok: false, error: "Unknown icon." };
  if (label == null && icon == null) return { ok: false, error: "Nothing to change." };
  return { ok: true, mac, label, icon };
}

// Wi-Fi or a cable: nothing on the network says, so Huginn guesses from the kind of device and you can correct it.
const LINKS = ["wifi", "cable"];
function guessLink(d = {}) { return ["computer", "server", "router"].includes(d.icon) ? "cable" : "wifi"; }
function checkLink(body) {
  if (!body || typeof body !== "object") return { ok: false, error: "No details sent." };
  const mac = String(body.mac || "").toUpperCase();
  if (!MAC.test(mac)) return { ok: false, error: "That isn't a device Huginn knows." };
  const link = body.link == null ? null : String(body.link);
  if (link != null && !LINKS.includes(link)) return { ok: false, error: "Wi-Fi or cable only." };
  return { ok: true, mac, link };
}

module.exports = { ICONS, guessIcon, checkRename, guessLink, checkLink };
