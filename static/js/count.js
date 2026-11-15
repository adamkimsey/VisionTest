// People counter: sends video frames to the server and draws the results.
import { $, el, fmtTime, toast, segmented } from "./util.js";
import { Source } from "./source.js";

const CORAL = "#ff5a52", TEAL = "#19b8a6", WHITE = "#ffffff";
const SEND_WIDTH = 640;          // frames are scaled down before they go to the server
const EVENT_TEXT = {
  new: "appeared",
  in: "crossed in",
  out: "crossed out",
  zone_enter: "entered the area",
};

export function initCount({ goInsights }) {
  const stage = $("#count-stage");
  const canvas = $("canvas", stage);
  const ctx = canvas.getContext("2d");
  const hud = $("#count-hud");
  const startBtn = $("#count-start");
  const nameInput = $("#count-name");
  const feed = $("#count-feed");
  const status = $("#count-status");
  const grab = document.createElement("canvas");

  const state = {
    running: false, ws: null, sessionId: null,
    line: null, zone: null,          // normalised 0..1 coordinates
    tool: null, draft: [], cursor: null,
    people: [], trails: new Map(),
    conf: 0.35, anchor: "feet", showTrails: true,
  };

  const source = new Source({
    stage, bar: $("#count-sourcebar"),
    onChange: (kind) => {
      startBtn.disabled = !kind;
      if (!kind && state.running) stop();
      if (!kind) { state.people = []; state.trails.clear(); }
    },
  });
  const video = source.video;
  video.addEventListener("ended", () => state.running && stop());

  // ---------- session ----------
  function start() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/track`);
    state.ws = ws;
    startBtn.disabled = true;
    startBtn.textContent = "Starting";
    ws.onopen = () => {
      sendConfig();
      const fallback = source.kind === "file" ? source.fileName : `Camera ${new Date().toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;
      ws.send(JSON.stringify({ type: "start", name: nameInput.value.trim() || fallback, source: source.kind === "file" ? "upload" : "camera" }));
    };
    ws.onmessage = async (msg) => {
      const data = JSON.parse(msg.data);
      if (data.type === "started") {
        state.sessionId = data.session_id;
        state.running = true;
        state.trails.clear();
        feed.replaceChildren();
        setRunningUI(true);
        if (source.kind === "file") {
          video.loop = false;
          video.currentTime = 0;
          await video.play().catch(() => {});
        }
        sendFrame();
      } else if (data.type === "result") {
        onResult(data);
        if (state.running) requestAnimationFrame(sendFrame);
      } else if (data.type === "stopped") {
        const id = data.session_id;
        showStats(data.stats);
        ws.close();
        toast("Session saved.", "View insights", () => goInsights(id));
      }
    };
    ws.onclose = () => {
      if (state.running) toast("The connection to the engine stopped. The session was saved.");
      state.running = false;
      state.ws = null;
      state.people = [];
      setRunningUI(false);
    };
    ws.onerror = () => toast("The engine did not answer. Make sure the app is still running.");
  }

  function stop() {
    if (!state.running) return;
    state.running = false;
    if (source.kind === "file") video.pause();
    state.ws?.send(JSON.stringify({ type: "stop" }));
    state.people = [];
    setRunningUI(false);
  }

  function setRunningUI(on) {
    startBtn.disabled = !source.active;
    startBtn.textContent = on ? "Stop and save" : "Start counting";
    startBtn.classList.toggle("primary", !on);
    startBtn.classList.toggle("solid", on);
    nameInput.disabled = on;
    source.setLocked(on);
    status.classList.toggle("live", on);
    status.firstElementChild.className = on ? "dot live" : "dot";
    status.lastElementChild.textContent = on ? "Counting" : "Not counting";
  }

  function sendConfig(extra) {
    if (state.ws?.readyState !== WebSocket.OPEN) return;
    state.ws.send(JSON.stringify(extra
      ? { type: "config", ...extra }
      : { type: "config", line: state.line, zone: state.zone, conf: state.conf, anchor: state.anchor }));
  }

  function sendFrame() {
    if (!state.running || state.ws?.readyState !== WebSocket.OPEN) return;
    if (video.readyState < 2 || !video.videoWidth) { setTimeout(sendFrame, 100); return; }
    grab.width = SEND_WIDTH;
    grab.height = Math.round((SEND_WIDTH * video.videoHeight) / video.videoWidth);
    grab.getContext("2d").drawImage(video, 0, 0, grab.width, grab.height);
    grab.toBlob((blob) => {
      if (blob && state.running && state.ws?.readyState === WebSocket.OPEN) state.ws.send(blob);
    }, "image/jpeg", 0.75);
  }

  function onResult(data) {
    state.people = data.people;
    const now = performance.now();
    for (const p of data.people) {
      const [x1, y1, x2, y2] = p.box;
      const pt = [(x1 + x2) / 2, state.anchor === "feet" ? y2 : (y1 + y2) / 2];
      const trail = state.trails.get(p.id) || { pts: [], seen: now };
      trail.pts.push(pt);
      if (trail.pts.length > 40) trail.pts.shift();
      trail.seen = now;
      state.trails.set(p.id, trail);
    }
    for (const [id, trail] of state.trails) if (now - trail.seen > 1500) state.trails.delete(id);

    showStats(data.stats);

    for (const ev of data.events) {
      const text = ev.kind === "zone_exit" ? `left the area after ${ev.value} s` : EVENT_TEXT[ev.kind];
      if (!text) continue;
      feed.prepend(el("li", {}, el("time", { text: fmtTime(ev.t) }), el("span", {}, el("b", { text: `Person ${ev.id} ` }), text)));
      while (feed.children.length > 40) feed.lastChild.remove();
    }
  }

  function showStats(s) {
    $("#st-unique").textContent = s.unique;
    $("#st-current").textContent = s.current;
    $("#st-in").textContent = s.in;
    $("#st-out").textContent = s.out;
    $("#st-zone").textContent = s.zone_now;
    $("#st-dwell").firstChild.textContent = s.avg_dwell;
    $("#count-clock").textContent = fmtTime(s.elapsed);
  }

  // ---------- drawing tools ----------
  const lineBtn = $("#tool-line"), zoneBtn = $("#tool-zone"), flipBtn = $("#tool-flip"), clearBtn = $("#tool-clear");

  function setTool(tool) {
    state.tool = state.tool === tool ? null : tool;
    state.draft = [];
    lineBtn.classList.toggle("active", state.tool === "line");
    zoneBtn.classList.toggle("active", state.tool === "zone");
    canvas.classList.toggle("draw", !!state.tool);
    hud.hidden = !state.tool;
    if (state.tool && !source.active) {
      hud.textContent = "Choose a video source first.";
    } else if (state.tool === "line") {
      hud.textContent = "Click two points to draw the count line. Esc cancels.";
    } else if (state.tool === "zone") {
      hud.textContent = "Click to add corners. Click the first point to close the area.";
    }
  }

  function syncToolButtons() {
    lineBtn.textContent = state.line ? "Redraw line" : "Draw line";
    zoneBtn.textContent = state.zone ? "Redraw area" : "Draw area";
    flipBtn.disabled = !state.line;
    clearBtn.disabled = !state.line && !state.zone;
  }

  function pointer(e) {
    const r = canvas.getBoundingClientRect();
    return [Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1), Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1)];
  }

  function finishZone() {
    if (state.draft.length < 3) return;
    state.zone = state.draft;
    sendConfig({ zone: state.zone });
    setTool(null);
    syncToolButtons();
  }

  canvas.addEventListener("pointermove", (e) => { state.cursor = state.tool ? pointer(e) : null; });
  canvas.addEventListener("pointerleave", () => { state.cursor = null; });
  canvas.addEventListener("click", (e) => {
    if (!state.tool) return;
    const pt = pointer(e);
    if (state.tool === "line") {
      state.draft.push(pt);
      if (state.draft.length === 2) {
        state.line = state.draft;
        sendConfig({ line: state.line });
        setTool(null);
        syncToolButtons();
      }
    } else {
      const first = state.draft[0];
      const r = canvas.getBoundingClientRect();
      const nearFirst = first && Math.hypot((pt[0] - first[0]) * r.width, (pt[1] - first[1]) * r.height) < 14;
      if (nearFirst && state.draft.length >= 3) finishZone();
      else state.draft.push(pt);
    }
  });
  canvas.addEventListener("dblclick", () => state.tool === "zone" && finishZone());
  document.addEventListener("keydown", (e) => {
    if (!state.tool) return;
    if (e.key === "Escape") setTool(null);
    if (e.key === "Enter" && state.tool === "zone") finishZone();
  });

  lineBtn.addEventListener("click", () => setTool("line"));
  zoneBtn.addEventListener("click", () => setTool("zone"));
  flipBtn.addEventListener("click", () => {
    if (!state.line) return;
    state.line = [state.line[1], state.line[0]];
    sendConfig({ line: state.line });
  });
  clearBtn.addEventListener("click", () => {
    state.line = null;
    state.zone = null;
    sendConfig({ line: null, zone: null });
    syncToolButtons();
  });

  // ---------- settings ----------
  const confInput = $("#conf");
  confInput.addEventListener("input", () => {
    state.conf = Number(confInput.value);
    $("#conf-val").textContent = state.conf <= 0.25 ? "High" : state.conf <= 0.45 ? "Medium" : "Low";
    sendConfig({ conf: state.conf });
  });
  segmented($("#anchor-seg"), (v) => { state.anchor = v; state.trails.clear(); sendConfig({ anchor: v }); });
  $("#trails").addEventListener("change", (e) => { state.showTrails = e.target.checked; });
  startBtn.addEventListener("click", () => (state.running ? stop() : start()));

  // ---------- overlay ----------
  function draw() {
    requestAnimationFrame(draw);
    if (!source.active || stage.closest("[hidden]")) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    const X = (v) => v * w, Y = (v) => v * h;

    // area
    const zone = state.tool === "zone" ? null : state.zone;
    if (zone) {
      ctx.beginPath();
      zone.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
      ctx.closePath();
      ctx.fillStyle = "rgba(25, 184, 166, 0.16)";
      ctx.fill();
      ctx.strokeStyle = TEAL;
      ctx.lineWidth = 2;
      ctx.stroke();
      label("AREA", X(zone[0][0]), Y(zone[0][1]) - 8, TEAL, "#04201c");
    }

    // count line with the "in" direction
    const line = state.tool === "line" ? null : state.line;
    if (line) {
      const [ax, ay, bx, by] = [X(line[0][0]), Y(line[0][1]), X(line[1][0]), Y(line[1][1])];
      stroke([[ax, ay], [bx, by]], "rgba(0,0,0,0.55)", 6);
      stroke([[ax, ay], [bx, by]], WHITE, 2.5);
      dot(ax, ay, 4.5, WHITE);
      dot(bx, by, 4.5, WHITE);
      const len = Math.hypot(bx - ax, by - ay) || 1;
      const nx = (by - ay) / len, ny = -(bx - ax) / len;   // direction that counts as "in"
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      const tx = mx + nx * 30, ty = my + ny * 30;
      stroke([[mx, my], [tx, ty]], CORAL, 2.5);
      ctx.beginPath();
      ctx.moveTo(tx + nx * 8, ty + ny * 8);
      ctx.lineTo(tx - ny * 6, ty + nx * 6);
      ctx.lineTo(tx + ny * 6, ty - nx * 6);
      ctx.closePath();
      ctx.fillStyle = CORAL;
      ctx.fill();
      label("IN", tx + nx * 22, ty + ny * 22 + 4, CORAL, "#0a0a0a", true);
    }

    // shape being drawn
    if (state.tool && state.draft.length) {
      const pts = state.draft.map(([x, y]) => [X(x), Y(y)]);
      if (state.cursor) pts.push([X(state.cursor[0]), Y(state.cursor[1])]);
      ctx.setLineDash([6, 5]);
      stroke(pts, state.tool === "line" ? WHITE : TEAL, 2);
      ctx.setLineDash([]);
      state.draft.forEach(([x, y]) => dot(X(x), Y(y), 5, state.tool === "line" ? WHITE : TEAL));
    }

    // trails
    if (state.showTrails && state.running) {
      for (const { pts } of state.trails.values()) {
        for (let i = 1; i < pts.length; i++) {
          ctx.globalAlpha = (i / pts.length) * 0.85;
          stroke([[X(pts[i - 1][0]), Y(pts[i - 1][1])], [X(pts[i][0]), Y(pts[i][1])]], CORAL, 2.5);
        }
        ctx.globalAlpha = 1;
      }
    }

    // people
    for (const p of state.people) {
      const [x1, y1, x2, y2] = [X(p.box[0]), Y(p.box[1]), X(p.box[2]), Y(p.box[3])];
      const color = p.zone ? TEAL : CORAL;
      const c = Math.min(16, (x2 - x1) / 3, (y2 - y1) / 3);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      for (const [cx, cy, dx, dy] of [[x1, y1, 1, 1], [x2, y1, -1, 1], [x2, y2, -1, -1], [x1, y2, 1, -1]]) {
        ctx.moveTo(cx + dx * c, cy);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx, cy + dy * c);
      }
      ctx.stroke();
      label(String(p.id), x1, Math.max(y1 - 7, 16), color, p.zone ? "#04201c" : "#0a0a0a");
      const ay = state.anchor === "feet" ? y2 : (y1 + y2) / 2;
      dot((x1 + x2) / 2, ay, 3.5, color);
    }
  }

  function stroke(pts, color, width) {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }
  function dot(x, y, r, color) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
  function label(text, x, y, bg, fg, centered = false) {
    ctx.font = "700 11px Inter, -apple-system, 'Segoe UI', sans-serif";
    const tw = ctx.measureText(text).width + 12;
    const lx = centered ? x - tw / 2 : x;
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(lx, y - 13, tw, 17, 5);
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.fillText(text, lx + 6, y);
  }

  syncToolButtons();
  draw();

  return {
    leave() {
      setTool(null);
      if (state.running) return;            // keep counting in the background
      if (source.kind === "camera") source.close();
    },
  };
}
