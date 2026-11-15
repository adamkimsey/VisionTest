// App shell: navigation, theme, engine status.
import { $, $$ } from "./util.js";
import { initCount } from "./count.js";
import { initInsights } from "./insights.js";

const views = {};
let active = "count";
let motionLoading = null;

async function go(name, arg) {
  if (name === "motion" && !views.motion) {
    // The 3D and pose libraries are large. Load them on first use.
    motionLoading ??= import("./motion.js").then((m) => { views.motion = m.initMotion(); });
    await motionLoading;
  }
  if (name !== active) views[active]?.leave?.();
  active = name;
  $$(".view").forEach((v) => { v.hidden = v.id !== `view-${name}`; });
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $("main").scrollTop = 0;
  views[name]?.enter?.(arg);
  history.replaceState(null, "", `#${name}`);
}

views.count = initCount({ goInsights: (id) => go("insights", id) });
views.insights = initInsights();

$$(".nav-item").forEach((b) => b.addEventListener("click", () => go(b.dataset.view)));
$$("[data-goto]").forEach((b) => b.addEventListener("click", () => go(b.dataset.goto)));

$("#theme-toggle").addEventListener("click", () => {
  const root = document.documentElement;
  const next = root.dataset.theme === "light" ? "dark" : "light";
  root.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch (e) {}
  document.dispatchEvent(new Event("themechange"));
});

async function pollEngine() {
  const dot = $("#engine-dot"), text = $("#engine-text");
  try {
    const health = await (await fetch("/api/health")).json();
    dot.className = health.model_ready ? "dot ok" : "dot";
    text.textContent = health.model_ready ? "Engine ready" : "Loading model";
    setTimeout(pollEngine, health.model_ready ? 15000 : 1500);
  } catch {
    dot.className = "dot";
    text.textContent = "Engine offline";
    setTimeout(pollEngine, 3000);
  }
}
pollEngine();

const start = location.hash.slice(1);
if (["motion", "insights"].includes(start)) go(start);
