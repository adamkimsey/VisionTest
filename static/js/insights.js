// Insights: results of saved people counting sessions.
import { $, el, fmtTime, fmtDate, toast } from "./util.js";
import { lineChart, barChart, heatmap } from "./charts.js";
import { store } from "./engine.js";

const EVENT_NAMES = {
  new: "Appeared", in: "Crossed in", out: "Crossed out",
  zone_enter: "Entered area", zone_exit: "Left area",
};
const BUCKETS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

export function initInsights() {
  const select = $("#ins-session");
  let sessions = [];
  let current = null;       // full data of the selected session

  async function load(selectId) {
    sessions = await store.list();
    $("#ins-empty").hidden = sessions.length > 0;
    $("#ins-body").hidden = sessions.length === 0;
    if (!sessions.length) return;
    select.replaceChildren(...sessions.map((s) => el("option", { value: s.id, text: `${s.name}  ·  ${fmtDate(s.started_at)}` })));
    const id = sessions.some((s) => s.id === Number(selectId)) ? Number(selectId) : sessions[0].id;
    select.value = id;
    renderAll();
    await show(id);
  }

  async function show(id) {
    const data = await store.get(id);
    if (!data) return;
    current = data;
    $("#ins-export").href = store.csvUrl(current);
    $("#ins-export").download = `session-${current.id}.csv`;
    render();
  }

  function kpi(label, value, unit, hero) {
    const v = el("div", { class: "v", text: value });
    if (unit) v.append(el("small", { text: unit }));
    return el("div", { class: hero ? "kpi hero" : "kpi" }, el("div", { class: "l", text: label }), v);
  }

  function render() {
    const s = current;
    if (!s) return;
    const css = getComputedStyle(document.documentElement);
    const s1 = css.getPropertyValue("--s1").trim(), s2 = css.getPropertyValue("--s2").trim();

    $("#ins-meta").textContent = `${s.source === "upload" ? "Uploaded video" : "Camera"} · ${fmtTime(s.duration)}${s.live ? " · counting now" : ""}`;
    $("#ins-kpis").replaceChildren(
      kpi("Unique people", s.unique_count, null, true),
      kpi("Crossed in", s.in_count),
      kpi("Crossed out", s.out_count),
      kpi("Peak in view", s.peak),
      kpi("Area visits", s.zone_entries),
      kpi("Avg time in area", Math.round(s.avg_dwell * 10) / 10, "s"),
    );

    // People over time
    const times = s.samples.map((r) => r[0]);
    const hasZone = s.samples.some((r) => r[2] > 0);
    const series = [{ name: "In view", color: s1, values: s.samples.map((r) => r[1]) }];
    if (hasZone) series.push({ name: "In area", color: s2, values: s.samples.map((r) => r[2]) });
    const legend = $("#occ-legend");
    legend.replaceChildren();
    legend.hidden = !hasZone;
    for (const item of series) {
      const key = el("i");
      key.style.background = item.color;
      legend.append(el("span", {}, key, item.name));
    }
    lineChart($("#chart-occ"), times, series, "This session is too short to chart.");

    // Line crossings per time bucket
    const size = BUCKETS.find((b) => s.duration / b <= 12) || 3600;
    const count = Math.max(1, Math.ceil(s.duration / size));
    const buckets = Array.from({ length: count }, (_, i) => ({
      label: fmtTime(i * size), title: `${fmtTime(i * size)} to ${fmtTime((i + 1) * size)}`, values: [0, 0],
    }));
    for (const e of s.events) {
      const b = buckets[Math.min(count - 1, Math.floor(e.t / size))];
      if (e.kind === "in") b.values[0]++;
      if (e.kind === "out") b.values[1]++;
    }
    $("#cross-sub").textContent = `Per ${size < 60 ? `${size} seconds` : size === 60 ? "minute" : `${size / 60} minutes`}`;
    barChart($("#chart-cross"), buckets, [{ name: "In", color: s1 }, { name: "Out", color: s2 }],
      "No line crossings. Draw a count line before you start a session.");

    heatmap($("#heat"), s.heatmap);

    // Event log (also the table view of the charts)
    const rows = s.events.filter((e) => e.kind !== "new").slice(-400).reverse();
    $("#ev-count").textContent = `${rows.length} event${rows.length === 1 ? "" : "s"}`;
    $("#ev-body").replaceChildren(...(rows.length ? rows.map((e) => el("tr", {},
      el("td", { text: fmtTime(e.t) }),
      el("td", { class: "name", text: EVENT_NAMES[e.kind] || e.kind }),
      el("td", { text: `Person ${e.track_id}` }),
      el("td", { class: "num-col", text: e.value != null ? `${e.value} s` : "" }),
    )) : [el("tr", {}, el("td", { colspan: 4, text: "No line or area events in this session." }))]));

    for (const tr of $("#all-body").children) tr.classList.toggle("sel", Number(tr.dataset.id) === s.id);
  }

  function renderAll() {
    const people = sessions.reduce((sum, s) => sum + s.unique_count, 0);
    $("#all-sub").textContent = `${sessions.length} session${sessions.length === 1 ? "" : "s"} · ${people} people counted`;
    $("#all-body").replaceChildren(...sessions.map((s) => {
      const tr = el("tr", { class: "click", "data-id": s.id },
        el("td", { class: "name", text: s.name }),
        el("td", { text: s.source === "upload" ? "Video" : "Camera" }),
        el("td", { text: fmtDate(s.started_at) }),
        el("td", { class: "num-col", text: fmtTime(s.duration) }),
        el("td", { class: "num-col", text: s.unique_count }),
        el("td", { class: "num-col", text: s.in_count }),
        el("td", { class: "num-col", text: s.out_count }),
        el("td", { class: "num-col", text: s.zone_entries }),
        el("td", { class: "num-col", text: s.peak }),
      );
      tr.addEventListener("click", () => { select.value = s.id; show(s.id); $("main").scrollTo({ top: 0, behavior: "smooth" }); });
      return tr;
    }));
  }

  select.addEventListener("change", () => show(Number(select.value)));
  $("#ins-delete").addEventListener("click", async () => {
    if (!current || !confirm(`Delete the session "${current.name}"? You cannot undo this.`)) return;
    await store.remove(current.id);
    toast("Session deleted.");
    current = null;
    load();
  });
  let resizeTimer;
  new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 150); }).observe($("#chart-occ"));
  document.addEventListener("themechange", render);

  return { enter: (id) => load(id) };
}
