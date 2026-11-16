// Counting engines. The app picks one when it starts:
//  - "server": the Python engine (YOLO + Supervision). Used when you run the app on your computer.
//  - "browser": a lighter engine that runs fully in the web page. Used on the hosted
//    page (GitHub Pages), where there is no Python. Sessions are saved in this browser.
// Both give the same results format, so the rest of the app does not care which one runs.

export const engine = { mode: "server", ready: false };

export async function detectEngine() {
  try {
    const res = await fetch("api/health", { cache: "no-store" });
    const data = await res.json();
    if (!data.ok) throw new Error("not the engine");
    engine.mode = "server";
    engine.ready = !!data.model_ready;
  } catch {
    engine.mode = "browser";
    engine.ready = true;
  }
  return engine;
}

export function createSession() {
  return engine.mode === "server" ? new ServerSession() : new BrowserSession();
}

// ===================================================================== server
const SEND_WIDTH = 640;          // frames are scaled down before they go to the server

class ServerSession {
  constructor() {
    this.grab = document.createElement("canvas");
    this.waiting = {};
    this.onLost = () => {};
    this.open = false;
  }

  /** Opens the connection and starts a session. Resolves with the session id. */
  start({ name, source, config }) {
    return new Promise((resolve, reject) => {
      const url = new URL("ws/track", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => {
        this.open = true;
        ws.send(JSON.stringify({ type: "config", ...config }));
        ws.send(JSON.stringify({ type: "start", name, source }));
      };
      ws.onmessage = (msg) => {
        const data = JSON.parse(msg.data);
        if (data.type === "started") resolve(data.session_id);
        const key = data.type === "result" ? "result" : data.type;
        this.waiting[key]?.(data);
        delete this.waiting[key];
      };
      ws.onerror = () => reject(new Error("The engine did not answer. Make sure the app is still running."));
      ws.onclose = () => {
        const wasOpen = this.open;
        this.open = false;
        this.waiting.result?.(null);
        if (wasOpen && !this.stopping) this.onLost();
      };
    });
  }

  configure(cfg) {
    if (this.open) this.ws.send(JSON.stringify({ type: "config", ...cfg }));
  }

  /** Sends one video frame. Resolves with the people found in it. */
  process(video) {
    return new Promise((resolve) => {
      if (!this.open) return resolve(null);
      const grab = this.grab;
      grab.width = SEND_WIDTH;
      grab.height = Math.round((SEND_WIDTH * video.videoHeight) / video.videoWidth);
      grab.getContext("2d").drawImage(video, 0, 0, grab.width, grab.height);
      grab.toBlob((blob) => {
        if (!blob || !this.open) return resolve(null);
        this.waiting.result = resolve;
        this.ws.send(blob);
      }, "image/jpeg", 0.75);
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.open) return resolve(null);
      this.stopping = true;
      this.waiting.stopped = (data) => { this.ws.close(); resolve(data); };
      this.ws.send(JSON.stringify({ type: "stop" }));
      setTimeout(() => resolve(null), 5000);
    });
  }
}

// ==================================================================== browser
const HEAT_W = 48, HEAT_H = 27;
const LOST_AFTER = 2.0;          // seconds before a missing person leaves the area
const MIN_DWELL = 0.5;
const TRACK_KEEP = 3.0;          // seconds a lost person keeps their ID
const CONFIRM_HITS = 3;

// The detector is the same YOLO model as the Python engine, converted to ONNX.
// It runs on the graphics card (WebGPU) when the browser has it, and on the CPU otherwise.
const INPUT = 640;
let detectorPromise = null;
function loadDetector() {
  detectorPromise ??= (async () => {
    const ort = await import("../vendor/ort/ort.webgpu.min.mjs");
    ort.env.wasm.wasmPaths = new URL("vendor/ort/", location.href).href;
    ort.env.wasm.numThreads = 1;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = INPUT;
    const detector = { ort, canvas, ctx: canvas.getContext("2d", { willReadFrequently: true }), input: new Float32Array(3 * INPUT * INPUT) };
    const providers = navigator.gpu ? ["webgpu", "wasm"] : ["wasm"];
    let lastError;
    for (const provider of providers) {
      try {
        detector.session = await ort.InferenceSession.create("models/yolo11n.onnx", { executionProviders: [provider] });
        detector.provider = provider;
        await runModel(detector);          // warm up, and prove that this provider works
        return detector;
      } catch (err) { lastError = err; console.warn(`Detector: ${provider} is not available.`, err); }
    }
    throw lastError;
  })();
  detectorPromise.catch(() => { detectorPromise = null; });
  return detectorPromise;
}

async function runModel(detector) {
  const { ort, session, input } = detector;
  const feeds = { [session.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, INPUT, INPUT]) };
  const output = (await session.run(feeds))[session.outputNames[0]];
  return output;                            // shape [1, 84, 8400]: box (4 values) + 80 class scores
}

/** Find people in the current video frame. Boxes are 0..1 of the frame. */
async function detectPeople(detector, video, minScore) {
  const { ctx, input } = detector;
  const vw = video.videoWidth, vh = video.videoHeight;
  // Fit the frame into a square, with grey bars (the model expects this).
  const scale = Math.min(INPUT / vw, INPUT / vh);
  const dw = vw * scale, dh = vh * scale, dx = (INPUT - dw) / 2, dy = (INPUT - dh) / 2;
  ctx.fillStyle = "rgb(114,114,114)";
  ctx.fillRect(0, 0, INPUT, INPUT);
  ctx.drawImage(video, dx, dy, dw, dh);
  const rgba = ctx.getImageData(0, 0, INPUT, INPUT).data;
  const area = INPUT * INPUT;
  for (let i = 0, p = 0; i < area; i++, p += 4) {
    input[i] = rgba[p] / 255;
    input[area + i] = rgba[p + 1] / 255;
    input[2 * area + i] = rgba[p + 2] / 255;
  }
  const output = await runModel(detector);
  const data = output.data, n = output.dims[2];
  const found = [];
  for (let i = 0; i < n; i++) {
    const score = data[4 * n + i];          // class 0 is "person"
    if (score < minScore) continue;
    const cx = data[i], cy = data[n + i], w = data[2 * n + i], h = data[3 * n + i];
    found.push({
      conf: score,
      box: [(cx - w / 2 - dx) / dw, (cy - h / 2 - dy) / dh, (cx + w / 2 - dx) / dw, (cy + h / 2 - dy) / dh].map((v) => Math.min(Math.max(v, 0), 1)),
    });
  }
  // Keep the best box for each person (non-maximum suppression).
  found.sort((a, b) => b.conf - a.conf);
  const kept = [];
  for (const d of found) if (!kept.some((k) => iou(k.box, d.box) > 0.5)) kept.push(d);
  return kept;
}

function iou(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter);
}

function insidePolygon([x, y], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

class BrowserSession {
  constructor() {
    this.onLost = () => {};
    this.cfg = { conf: 0.35, anchor: "center", line: null, zone: null };
    this.tracks = [];
    this.nextId = 1;
    this.unique = 0;
    this.inCount = 0;
    this.outCount = 0;
    this.zoneEntries = 0;
    this.dwells = [];
    this.peak = 0;
    this.inZone = new Map();
    this.heat = Array.from({ length: HEAT_H }, () => new Array(HEAT_W).fill(0));
    this.samples = [];
    this.events = [];
    this.lastT = 0;
    this.lastSample = -1;
    this.current = 0;
  }

  async start({ name, source, config }) {
    this.detector = await loadDetector();
    Object.assign(this.cfg, config);
    this.meta = { id: Date.now(), name, source, started_at: Date.now() / 1000 };
    this.t0 = performance.now();
    return this.meta.id;
  }

  configure(cfg) {
    if ("zone" in cfg) this.closeAllVisits();
    if ("line" in cfg || "anchor" in cfg) this.tracks.forEach((t) => { t.side = null; });
    Object.assign(this.cfg, cfg);
  }

  elapsed() { return (performance.now() - this.t0) / 1000; }

  anchorOf(box) {
    return [(box[0] + box[2]) / 2, this.cfg.anchor === "feet" ? box[3] : (box[1] + box[3]) / 2];
  }

  async process(video) {
    const started = performance.now();
    const t = this.elapsed();
    const dt = Math.min(t - this.lastT, 1);
    this.lastT = t;
    const found = await detectPeople(this.detector, video, this.cfg.conf);
    const events = [];
    this.track(found, t, events);

    const visible = this.tracks.filter((tr) => tr.id && tr.seen === t);
    const { line, zone } = this.cfg;
    for (const tr of visible) {
      const p = this.anchorOf(tr.box);
      // Line: a change of side is a crossing. The direction gives "in" or "out".
      if (line) {
        const [a, b] = line;
        const vx = b[0] - a[0], vy = b[1] - a[1];
        const side = Math.sign(vx * (p[1] - a[1]) - vy * (p[0] - a[0]));
        const along = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / (vx * vx + vy * vy || 1);
        if (tr.side && side && side !== tr.side && along >= 0 && along <= 1) {
          if (side < 0) { this.inCount++; this.event(t, "in", tr.id, null, events); }
          else { this.outCount++; this.event(t, "out", tr.id, null, events); }
        }
        if (side) tr.side = side;
      }
      tr.zone = zone ? insidePolygon(p, zone) : false;
      const gx = Math.min(Math.max(Math.floor(p[0] * HEAT_W), 0), HEAT_W - 1);
      const gy = Math.min(Math.max(Math.floor(p[1] * HEAT_H), 0), HEAT_H - 1);
      this.heat[gy][gx] += dt;
    }
    if (zone) this.updateZone(t, visible, events);

    this.current = visible.length;
    this.peak = Math.max(this.peak, this.current);
    if (t - this.lastSample >= 1) {
      this.lastSample = t;
      this.samples.push([Math.round(t * 100) / 100, this.current, this.inZone.size]);
    }
    return {
      type: "result",
      people: visible.map((tr) => ({ id: tr.id, box: tr.box, conf: Math.round(tr.conf * 100) / 100, zone: tr.zone })),
      stats: this.totals(),
      events,
      ms: Math.round(performance.now() - started),
    };
  }

  /** Match the people in this frame to the people already known. */
  track(found, t, events) {
    const pairs = [];
    this.tracks.forEach((tr, ti) => found.forEach((d, di) => {
      let score = iou(tr.box, d.box);
      if (score < 0.1) {
        // No overlap (fast movement, a slow computer or a short gap): accept a
        // close neighbour of similar size. A longer gap allows a longer distance.
        const tw = tr.box[2] - tr.box[0], th = tr.box[3] - tr.box[1];
        const dwid = d.box[2] - d.box[0], dhgt = d.box[3] - d.box[1];
        const size = Math.max(tw, th);
        const dist = Math.hypot((tr.box[0] + tr.box[2] - d.box[0] - d.box[2]) / 2, (tr.box[1] + tr.box[3] - d.box[1] - d.box[3]) / 2);
        const reach = size * Math.min(0.5 + (t - tr.seen) * 0.8, 1.2);
        const alike = th / dhgt > 0.6 && th / dhgt < 1.6 && tw / dwid > 0.4 && tw / dwid < 2.5;
        score = alike && dist < reach ? 0.1 * (1 - dist / reach) : 0;
      }
      if (score > 0.02) pairs.push([score, ti, di]);
    }));
    pairs.sort((a, b) => b[0] - a[0]);
    const usedT = new Set(), usedD = new Set();
    for (const [, ti, di] of pairs) {
      if (usedT.has(ti) || usedD.has(di)) continue;
      usedT.add(ti);
      usedD.add(di);
      const tr = this.tracks[ti];
      Object.assign(tr, { box: found[di].box, conf: found[di].conf, seen: t, hits: tr.hits + 1 });
      if (!tr.id && tr.hits >= CONFIRM_HITS) {
        tr.id = this.nextId++;
        this.unique++;
        this.event(t, "new", tr.id, null, events);
      }
    }
    found.forEach((d, di) => {
      if (!usedD.has(di)) this.tracks.push({ id: 0, box: d.box, conf: d.conf, seen: t, hits: 1, side: null, zone: false });
    });
    this.tracks = this.tracks.filter((tr) => t - tr.seen < (tr.id ? TRACK_KEEP : 0.5));
  }

  event(t, kind, id, value, out) {
    this.events.push({ t: Math.round(t * 100) / 100, kind, track_id: id, value });
    out.push({ t: Math.round(t * 10) / 10, kind, id, value });
  }

  updateZone(t, visible, events) {
    const seen = new Map(visible.map((tr) => [tr.id, tr.zone]));
    for (const [id, isIn] of seen) {
      if (!isIn) continue;
      if (!this.inZone.has(id)) {
        this.inZone.set(id, { enter: t, seen: t });
        this.zoneEntries++;
        this.event(t, "zone_enter", id, null, events);
      } else this.inZone.get(id).seen = t;
    }
    for (const [id, visit] of [...this.inZone]) {
      const left = seen.has(id) && !seen.get(id);
      const lost = !seen.has(id) && t - visit.seen > LOST_AFTER;
      if (left || lost) this.closeVisit(id, left ? t : visit.seen, events);
    }
  }

  closeVisit(id, t, events) {
    const visit = this.inZone.get(id);
    this.inZone.delete(id);
    const dwell = t - visit.enter;
    if (dwell >= MIN_DWELL) {
      this.dwells.push(dwell);
      this.event(t, "zone_exit", id, Math.round(dwell * 100) / 100, events);
    } else this.zoneEntries = Math.max(this.zoneEntries - 1, 0);
  }

  closeAllVisits() {
    for (const [id, visit] of [...this.inZone]) this.closeVisit(id, visit.seen, []);
  }

  totals() {
    const avg = this.dwells.length ? this.dwells.reduce((a, b) => a + b, 0) / this.dwells.length : 0;
    return {
      elapsed: Math.round(this.elapsed() * 10) / 10,
      current: this.current, unique: this.unique, in: this.inCount, out: this.outCount,
      zone_now: this.inZone.size, zone_entries: this.zoneEntries,
      avg_dwell: Math.round(avg * 10) / 10, peak: this.peak,
    };
  }

  async stop() {
    this.closeAllVisits();
    this.current = 0;
    const stats = this.totals();
    localStore.save({
      ...this.meta, ended_at: Date.now() / 1000, duration: stats.elapsed, live: false,
      unique_count: stats.unique, in_count: stats.in, out_count: stats.out,
      zone_entries: stats.zone_entries, avg_dwell: stats.avg_dwell, peak: stats.peak,
      heatmap: this.heat.map((row) => row.map((v) => Math.round(v * 100) / 100)),
      samples: this.samples, events: this.events,
    });
    return { session_id: this.meta.id, stats };
  }
}

// ====================================================================== store
const KEY = "visiontest.sessions";
const MAX_SESSIONS = 40;

const localStore = {
  all() {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
  },
  write(list) {
    // Browser storage is small. When it is full, drop the oldest sessions.
    while (list.length) {
      try { localStorage.setItem(KEY, JSON.stringify(list)); return; } catch { list.pop(); }
    }
    try { localStorage.removeItem(KEY); } catch { /* storage not available */ }
  },
  save(session) { this.write([session, ...this.all()].slice(0, MAX_SESSIONS)); },
};

/** Saved sessions. Same data from the server database or from browser storage. */
export const store = {
  async list() {
    if (engine.mode === "server") return (await fetch("api/sessions")).json();
    return localStore.all().map(({ samples, events, heatmap, ...summary }) => summary);
  },
  async get(id) {
    if (engine.mode === "server") {
      const res = await fetch(`api/sessions/${id}`);
      return res.ok ? res.json() : null;
    }
    return localStore.all().find((s) => s.id === id) || null;
  },
  async remove(id) {
    if (engine.mode === "server") await fetch(`api/sessions/${id}`, { method: "DELETE" });
    else localStore.write(localStore.all().filter((s) => s.id !== id));
  },
  /** A link that downloads the event list as CSV. */
  csvUrl(session) {
    if (engine.mode === "server") return `api/sessions/${session.id}/export.csv`;
    const rows = [["time_seconds", "event", "person_id", "dwell_seconds"],
      ...session.events.map((e) => [e.t, e.kind, e.track_id, e.value ?? ""])];
    return URL.createObjectURL(new Blob([rows.map((r) => r.join(",")).join("\n") + "\n"], { type: "text/csv" }));
  },
};
