// Who owns a host name, in words a person knows. Pure, no lookups.
// "rr5---sn-8xgp1vo-p5qe.googlevideo.com" -> "Google".

const OWNERS = [
  ["Google", /(^|\.)(google|googleapis|gstatic|googlevideo|googleusercontent|youtube|ytimg|ggpht|doubleclick|gvt[12]|1e100|android|googlesyndication|google-analytics|app-measurement)\.[a-z.]+$/],
  ["Microsoft", /(^|\.)(microsoft|windows|windowsupdate|live|msn|office|office365|azure|azureedge|azurefd|bing|xbox|xboxlive|skype|msedge|msftconnecttest|onedrive|sharepoint|outlook|aka|trafficmanager|microsoftonline|visualstudio|vsassets|gfx)\.[a-z.]+$/],
  ["Amazon", /(^|\.)(amazon|amazonaws|cloudfront|a2z|media-amazon|ssl-images-amazon|amazonvideo|primevideo|alexa)\.[a-z.]+$/],
  ["Cloudflare", /(^|\.)(cloudflare|cloudflare-dns|cloudflareinsights|workers|pages)\.(com|net|dev)$/],
  ["Akamai", /(^|\.)(akamai|akamaized|akamaiedge|akamaihd|edgekey|edgesuite)\.net$/],
  ["Discord", /(^|\.)(discord|discordapp|discord\.media)\.[a-z.]+$/],
  ["Steam", /(^|\.)(steampowered|steamcommunity|steamstatic|steamcontent|steamserver|valvesoftware)\.[a-z.]+$/],
  ["Apple", /(^|\.)(apple|icloud|mzstatic|apple-dns|cdn-apple)\.[a-z.]+$/],
  ["Meta", /(^|\.)(facebook|fbcdn|instagram|whatsapp|fbsbx|meta)\.[a-z.]+$/],
  ["Netflix", /(^|\.)(netflix|nflxvideo|nflximg|nflxext|nflxso)\.[a-z.]+$/],
  ["GitHub", /(^|\.)(github|githubusercontent|githubassets)\.[a-z.]+$/],
  ["Anthropic", /(^|\.)(anthropic|claude|claudeusercontent)\.[a-z.]+$/],
  ["Spotify", /(^|\.)(spotify|scdn|spotifycdn)\.[a-z.]+$/],
  ["Twitch", /(^|\.)(twitch|ttvnw|jtvnw)\.[a-z.]+$/],
  ["Tailscale", /(^|\.)(tailscale)\.(com|io|net)$/],
];

const TWO_PART_TLDS = /\.(co|com|org|net|gov|ac)\.[a-z]{2}$/;

function orgOf(name) {
  if (!name) return null;
  const n = String(name).toLowerCase().replace(/\.$/, "");
  for (const [owner, re] of OWNERS) if (re.test(n)) return owner;
  const parts = n.split(".");
  if (parts.length < 2) return n;
  return parts.slice(TWO_PART_TLDS.test(n) ? -3 : -2).join(".");
}

module.exports = { orgOf };
