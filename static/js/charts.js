// Small SVG charts for the Insights view. No chart library needed.
import { el, fmtTime } from "./util.js";

const NS = "http://www.w3.org/2000/svg";
const PAD = { top: 10, right: 12, bottom: 24, left: 30 };

function svg(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function niceMax(v) {
  if (v <= 4) return 4;
  const step = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 4, 5, 10]) if (v <= m * step) return m * step;
  return v;
}

function setup(box, emptyText, hasData) {
  box.replaceChildren();
  const w = box.clientWidth, h = box.clientHeight;
  if (!hasData || !w) {
    box.append(el("div", { class: "chart-empty", text: emptyText }));
    return null;
  }
  const root = svg("svg", { viewBox: `0 0 ${w} ${h}`, role: "img" });
  box.append(root);
  const tip = el("div", { class: "tip", hidden: true });
  box.append(tip);
  return { root, tip, w, h, iw: w - PAD.left - PAD.right, ih: h - PAD.top - PAD.bottom };
}

function axes(c, yMax, xLabels) {
  for (let i = 0; i <= 4; i++) {
    const y = PAD.top + c.ih - (c.ih * i) / 4;
    c.root.append(svg("line", { class: "gridline", x1: PAD.left, x2: PAD.left + c.iw, y1: y, y2: y }));
    const value = (yMax * i) / 4;
    if (Number.isInteger(value)) {
      const t = svg("text", { x: PAD.left - 8, y: y + 4, "text-anchor": "end" });
      t.textContent = value;
      c.root.append(t);
    }
  }
  for (const { x, text, anchor = "middle" } of xLabels) {
    const t = svg("text", { x, y: c.h - 6, "text-anchor": anchor });
    t.textContent = text;
    c.root.append(t);
  }
}

function showTip(c, x, y, title, rows) {
  c.tip.replaceChildren(el("div", { class: "t", text: title }));
  for (const { color, value, name } of rows) {
    const key = el("i");
    key.style.background = color;
    c.tip.append(el("div", { class: "r" }, key, el("b", { text: value }), el("span", { text: name })));
  }
  c.tip.hidden = false;
  const half = c.tip.offsetWidth / 2;
  c.tip.style.left = `${Math.min(Math.max(x, half), c.w - half)}px`;
  c.tip.style.top = `${Math.max(y - 10, c.tip.offsetHeight + 2)}px`;
}

/** Step line chart. series: [{ name, color, values }] on shared times (seconds). */
export function lineChart(box, times, series, emptyText) {
  const c = setup(box, emptyText, times.length > 1);
  if (!c) return;
  const tMax = times.at(-1) || 1;
  const yMax = niceMax(Math.max(1, ...series.flatMap((s) => s.values)));
  const X = (t) => PAD.left + (t / tMax) * c.iw;
  const Y = (v) => PAD.top + c.ih - (v / yMax) * c.ih;
  axes(c, yMax, [0, 0.25, 0.5, 0.75, 1].map((f, i) => ({
    x: PAD.left + f * c.iw, text: fmtTime(f * tMax), anchor: i === 0 ? "start" : i === 4 ? "end" : "middle",
  })));

  series.forEach((s, index) => {
    let d = "";
    s.values.forEach((v, i) => {
      d += i === 0 ? `M${X(times[i])},${Y(v)}` : `H${X(times[i])}V${Y(v)}`;
    });
    if (index === 0) {
      c.root.append(svg("path", { d: `${d}V${Y(0)}H${X(times[0])}Z`, fill: s.color, opacity: 0.1 }));
    }
    c.root.append(svg("path", { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round" }));
  });

  const cross = svg("line", { class: "cross", y1: PAD.top, y2: PAD.top + c.ih, visibility: "hidden" });
  c.root.append(cross);
  const hit = svg("rect", { x: PAD.left, y: PAD.top, width: c.iw, height: c.ih, fill: "transparent" });
  c.root.append(hit);
  hit.addEventListener("pointermove", (e) => {
    const r = c.root.getBoundingClientRect();
    const t = ((e.clientX - r.left - PAD.left) / c.iw) * tMax;
    let i = 0;
    for (let k = 1; k < times.length; k++) if (Math.abs(times[k] - t) < Math.abs(times[i] - t)) i = k;
    const x = X(times[i]);
    cross.setAttribute("x1", x);
    cross.setAttribute("x2", x);
    cross.setAttribute("visibility", "visible");
    showTip(c, x, PAD.top + 6, fmtTime(times[i]), series.map((s) => ({ color: s.color, value: s.values[i], name: s.name })));
  });
  hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); c.tip.hidden = true; });
}

/** Grouped bars. buckets: [{ label, values: [a, b] }], series: [{ name, color }]. */
export function barChart(box, buckets, series, emptyText) {
  const total = buckets.reduce((sum, b) => sum + b.values.reduce((x, y) => x + y, 0), 0);
  const c = setup(box, emptyText, total > 0);
  if (!c) return;
  const yMax = niceMax(Math.max(...buckets.flatMap((b) => b.values)));
  const slot = c.iw / buckets.length;
  const bar = Math.max(2, Math.min(18, (slot - 8) / series.length - 2));
  const every = Math.ceil(buckets.length / 6);
  axes(c, yMax, buckets.map((b, i) => ({ x: PAD.left + slot * (i + 0.5), text: b.label, i }))
    .filter(({ i }) => i % every === 0));

  buckets.forEach((b, i) => {
    const centre = PAD.left + slot * (i + 0.5);
    const groupW = series.length * bar + (series.length - 1) * 2;
    b.values.forEach((v, k) => {
      if (!v) return;
      const hgt = Math.max((v / yMax) * c.ih, 2);
      const x = centre - groupW / 2 + k * (bar + 2);
      const y = PAD.top + c.ih - hgt;
      const r = Math.min(4, bar / 2, hgt);
      c.root.append(svg("path", {
        d: `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + bar - r}Q${x + bar},${y} ${x + bar},${y + r}V${y + hgt}Z`,
        fill: series[k].color,
      }));
    });
    const hit = svg("rect", { x: PAD.left + slot * i, y: PAD.top, width: slot, height: c.ih, fill: "transparent", tabindex: 0 });
    const show = () => {
      hit.setAttribute("fill", "currentColor");
      hit.setAttribute("opacity", 0.06);
      showTip(c, centre, PAD.top + 6, b.title, series.map((s, k) => ({ color: s.color, value: b.values[k], name: s.name })));
    };
    const hide = () => { hit.setAttribute("fill", "transparent"); c.tip.hidden = true; };
    hit.addEventListener("pointerenter", show);
    hit.addEventListener("focus", show);
    hit.addEventListener("pointerleave", hide);
    hit.addEventListener("blur", hide);
    c.root.append(hit);
  });
}

/** Heatmap of time spent. grid: rows of seconds. One hue, light to strong. */
export function heatmap(box, grid) {
  const canvas = box.querySelector("canvas");
  box.querySelector(".tip")?.remove();
  box.querySelector(".chart-empty")?.remove();
  const ctx = canvas.getContext("2d");
  const rows = grid?.length || 0, cols = grid?.[0]?.length || 0;
  const max = rows ? Math.max(...grid.flat()) : 0;
  const w = box.clientWidth, h = box.clientHeight, dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  canvas.onpointermove = canvas.onpointerleave = null;
  if (!max) {
    const note = el("div", { class: "chart-empty", text: "No positions recorded in this session." });
    Object.assign(note.style, { position: "absolute", inset: "0", height: "auto" });
    box.append(note);
    return;
  }
  const styles = getComputedStyle(document.documentElement);
  const color = styles.getPropertyValue("--s1").trim();
  const base = styles.getPropertyValue("--surface-2").trim();
  const cw = w / cols, ch = h / rows;
  for (let r = 0; r < rows; r++) {
    for (let cidx = 0; cidx < cols; cidx++) {
      const v = grid[r][cidx];
      ctx.globalAlpha = 1;
      ctx.fillStyle = base;
      ctx.fillRect(cidx * cw + 1, r * ch + 1, cw - 2, ch - 2);
      if (v > 0) {
        ctx.globalAlpha = 0.18 + 0.82 * Math.sqrt(v / max);
        ctx.fillStyle = color;
        ctx.fillRect(cidx * cw + 1, r * ch + 1, cw - 2, ch - 2);
      }
    }
  }
  ctx.globalAlpha = 1;
  const tip = el("div", { class: "tip", hidden: true });
  box.append(tip);
  canvas.onpointermove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const cidx = Math.min(cols - 1, Math.floor(((e.clientX - rect.left) / rect.width) * cols));
    const r = Math.min(rows - 1, Math.floor(((e.clientY - rect.top) / rect.height) * rows));
    const v = grid[r][cidx];
    tip.replaceChildren(el("div", { class: "r" }, el("b", { text: `${v.toFixed(1)} s` }), el("span", { text: "of people time here" })));
    tip.hidden = false;
    tip.style.left = `${Math.min(Math.max(e.clientX - rect.left, 80), w - 80)}px`;
    tip.style.top = `${Math.max(e.clientY - rect.top - 12, 34)}px`;
  };
  canvas.onpointerleave = () => { tip.hidden = true; };
}
