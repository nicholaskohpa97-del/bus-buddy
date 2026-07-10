// ── Inline-SVG charts (no library). Single-series, theme-aware via CSS vars. ──
import { esc } from "./ui.js";

// entries: [{ label, x (number, e.g. day index or ms), v (number) }]
// opts: { goal, unit, height, format }
export function lineChart(entries, opts = {}) {
  const W = 600, H = opts.height || 220;
  const padL = 44, padR = 16, padT = 16, padB = 28;
  if (!entries || entries.length === 0) {
    return `<div class="chart-empty">No data yet — log an entry to see your trend.</div>`;
  }

  const xs = entries.map((e) => e.x);
  const vs = entries.map((e) => e.v);
  const goal = opts.goal != null ? Number(opts.goal) : null;

  let minV = Math.min(...vs, goal != null ? goal : Infinity);
  let maxV = Math.max(...vs, goal != null ? goal : -Infinity);
  if (minV === maxV) { minV -= 1; maxV += 1; }
  const span = maxV - minV;
  minV -= span * 0.12; maxV += span * 0.12;

  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const xSpan = maxX - minX || 1;

  const sx = (x) => padL + ((x - minX) / xSpan) * (W - padL - padR);
  const sy = (v) => padT + (1 - (v - minV) / (maxV - minV)) * (H - padT - padB);

  const fmt = opts.format || ((v) => Math.round(v));

  // recessive horizontal grid + y labels (3 lines)
  let grid = "";
  const ticks = 3;
  for (let i = 0; i <= ticks; i++) {
    const v = minV + ((maxV - minV) * i) / ticks;
    const y = sy(v);
    grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-width="1" opacity="0.6"/>`;
    grid += `<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--text2)">${esc(fmt(v))}</text>`;
  }

  // goal line
  let goalLine = "";
  if (goal != null) {
    const gy = sy(goal);
    goalLine = `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}" stroke="var(--green)" stroke-width="1.5" stroke-dasharray="5 4" opacity="0.8"/>`
      + `<text x="${W - padR}" y="${(gy - 5).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--green)" font-weight="700">Goal ${esc(fmt(goal))}</text>`;
  }

  // line + area
  const pts = entries.map((e) => [sx(e.x), sy(e.v)]);
  const linePath = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${pts[pts.length - 1][0].toFixed(1)} ${(H - padB).toFixed(1)} L${pts[0][0].toFixed(1)} ${(H - padB).toFixed(1)} Z`;

  // dots (emphasise last)
  let dots = "";
  pts.forEach((p, i) => {
    const last = i === pts.length - 1;
    dots += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${last ? 4.5 : 3}" fill="var(--accent)" stroke="var(--surface)" stroke-width="${last ? 2 : 1.5}"><title>${esc(entries[i].label)}: ${esc(fmt(entries[i].v))}${opts.unit ? " " + esc(opts.unit) : ""}</title></circle>`;
  });

  // x end labels
  const xLabels = `<text x="${padL}" y="${H - 8}" text-anchor="start" font-size="11" fill="var(--text2)">${esc(entries[0].label)}</text>`
    + (entries.length > 1 ? `<text x="${W - padR}" y="${H - 8}" text-anchor="end" font-size="11" fill="var(--text2)">${esc(entries[entries.length - 1].label)}</text>` : "");

  const gid = "cg" + Math.random().toString(36).slice(2, 7);
  return `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Trend chart">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="var(--accent)" stop-opacity="0.28"/>
      <stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid}${goalLine}
    <path d="${areaPath}" fill="url(#${gid})"/>
    <path d="${linePath}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}${xLabels}
  </svg></div>`;
}

// Simple weekly bar chart for calories (single series).
export function barChart(entries, opts = {}) {
  const W = 600, H = opts.height || 180;
  const padL = 40, padR = 12, padT = 14, padB = 26;
  if (!entries || entries.length === 0) {
    return `<div class="chart-empty">No data yet.</div>`;
  }
  const vs = entries.map((e) => e.v);
  const goal = opts.goal != null ? Number(opts.goal) : null;
  const maxV = Math.max(...vs, goal != null ? goal : 0, 1) * 1.15;
  const n = entries.length;
  const gap = 8;
  const bw = (W - padL - padR - gap * (n - 1)) / n;
  const sy = (v) => padT + (1 - v / maxV) * (H - padT - padB);

  let bars = "";
  entries.forEach((e, i) => {
    const x = padL + i * (bw + gap);
    const y = sy(e.v);
    const h = Math.max(0, H - padB - y);
    const over = goal != null && e.v > goal;
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${over ? "var(--red)" : "var(--accent)"}"><title>${esc(e.label)}: ${esc(Math.round(e.v))}</title></rect>`;
    bars += `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--text2)">${esc(e.short || e.label)}</text>`;
  });

  let goalLine = "";
  if (goal != null) {
    const gy = sy(goal);
    goalLine = `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}" stroke="var(--green)" stroke-width="1.5" stroke-dasharray="5 4" opacity="0.8"/>`;
  }

  return `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Calorie bar chart">
    ${goalLine}${bars}
  </svg></div>`;
}
