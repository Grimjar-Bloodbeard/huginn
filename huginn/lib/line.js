// Is the line healthy, and if not, where is the hold-up? Pure.
// in: { routerMs: [..recent], netMs: [..recent] (null = lost), netBaseline,
//       downBps, upBps, peakDownBps, peakUpBps, topTalker }
// out: { level: "clear" | "busy" | "slow" | "down", text }

function median(xs) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function ms(x) { return `${Math.round(x)} ms`; }

function assessLine(s) {
  const net = (s.netMs || []).slice(-10);
  const router = (s.routerMs || []).slice(-10);
  if (!net.length) return { level: "clear", text: "Measuring the line." };

  const lost = net.filter((x) => x == null).length / net.length;
  const routerNow = median(router);
  const netNow = median(net.slice(-4));
  const base = s.netBaseline;

  if (lost >= 0.5 && router.filter((x) => x == null).length / Math.max(router.length, 1) >= 0.5)
    return { level: "down", text: "Neither the router nor the internet is answering. Check this PC's cable." };
  if (lost >= 0.5)
    return { level: "down", text: "The router answers but the internet doesn't. The outage is past the router." };
  if (routerNow != null && routerNow > 20)
    return { level: "slow", text: `The router is slow to answer (${ms(routerNow)}). The hold-up is inside the house.` };

  const full = (s.peakDownBps > 0 && s.downBps > 0.6 * s.peakDownBps) ||
               (s.peakUpBps > 0 && s.upBps > 0.6 * s.peakUpBps);
  if (netNow != null && base != null && netNow > base * 2 && netNow > base + 30) {
    if (full) {
      const who = s.topTalker ? ` ${s.topTalker} is the biggest talker.` : "";
      return { level: "busy", text: `The line is full and replies slowed to ${ms(netNow)} (usually ${ms(base)}).${who}` };
    }
    return { level: "slow", text: `Internet replies slowed to ${ms(netNow)} (usually ${ms(base)}), and it isn't this PC filling the line.` };
  }
  if (lost > 0) return { level: "busy", text: `Some replies are getting lost (${Math.round(lost * 100)}% of the last ${net.length}).` };

  const r = routerNow != null ? `router ${ms(routerNow)}` : "router not measured";
  return { level: "clear", text: `The line is clear: ${r}, internet ${ms(netNow)}.` };
}

module.exports = { assessLine, median };
