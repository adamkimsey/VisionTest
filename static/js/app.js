// App shell: navigation, theme, engine status.
import { $, $$ } from "./util.js";
import { initCount } from "./count.js";
import { initInsights } from "./insights.js";
import { engine, detectEngine } from "./engine.js";

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
  const wasServer = engine.mode === "server" && engine.checked;
  await detectEngine();
  if (engine.mode === "browser" && wasServer) {
    // The local engine was running and stopped. Do not switch engines without telling the user.
    engine.mode = "server";
    dot.className = "dot";
    text.textContent = "Engine offline";
    setTimeout(pollEngine, 3000);
    return;
  }
  engine.checked = true;
  if (engine.mode === "browser") {
    dot.className = "dot ok";
    text.textContent = "Browser engine";
    text.title = "Counting runs in this browser. Sessions are saved in this browser only.";
    return;
  }
  dot.className = engine.ready ? "dot ok" : "dot";
  text.textContent = engine.ready ? "Engine ready" : "Loading model";
  setTimeout(pollEngine, engine.ready ? 15000 : 1500);
}
await pollEngine();

const start = location.hash.slice(1);
if (["motion", "insights"].includes(start)) go(start);
