// Motion capture: finds 33 body points per person in the video (MediaPipe
// Pose, runs in the browser) and applies them to 3D characters (three.js).
// It follows up to two people.
import * as THREE from "../vendor/three/three.module.js";
import { OrbitControls } from "../vendor/three/OrbitControls.js";
import { FilesetResolver, PoseLandmarker } from "../vendor/mediapipe/vision_bundle.mjs";
import { $, $$, fmtTime, toast, segmented } from "./util.js";
import { Source } from "./source.js";
import { SkeletonSkin, BodySkin, RigSkin } from "./avatar.js";
import { buildBVH } from "./bvh.js";
import { Hologram } from "./hologram.js";

const MAX_PEOPLE = 2;
const COLORS = [{ css: "#ff5a52", hex: 0xff5a52 }, { css: "#19b8a6", hex: 0x19b8a6 }];   // person 1, person 2
const LOST_AFTER = 700;      // ms without a detection before a person is dropped
const SIDE_OFFSET = 0.6;     // metres between the centre and each of two characters
const JOINT_NAMES = [
  "nose", "left_eye_inner", "left_eye", "left_eye_outer", "right_eye_inner", "right_eye", "right_eye_outer",
  "left_ear", "right_ear", "mouth_left", "mouth_right", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
  "left_wrist", "right_wrist", "left_pinky", "right_pinky", "left_index", "right_index", "left_thumb", "right_thumb",
  "left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle", "left_heel", "right_heel",
  "left_foot_index", "right_foot_index",
];
const LINKS = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [27, 31], [28, 32], [27, 29], [28, 30]];
// Limbs that release hologram particles: arms, legs, body, and neck to head.
const TRAIL_LINKS = [[11, 13], [13, 15], [15, 19], [12, 14], [14, 16], [16, 20], [23, 25], [25, 27], [27, 31], [24, 26], [26, 28], [28, 32], [11, 23], [12, 24], [11, 12], [7, 8]];
const BODY_IDS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
// Index of the opposite-side point, used for the mirror view.
const SWAP = JOINT_NAMES.map((n) => JOINT_NAMES.indexOf(n.startsWith("left_") ? n.replace("left_", "right_") : n.replace("right_", "left_")));
const SKIN_LABELS = { skeleton: "Skeleton", body: "Body", mesh: "Mesh", custom: "Your model" };

export function initMotion() {
  const stage = $("#motion-stage");
  const frame = $(".frame", stage);
  const canvas = $("canvas", stage);
  const ctx = canvas.getContext("2d");
  const viewport = $("#motion-viewport");
  const status = $("#motion-status");
  const recordBtn = $("#motion-record"), exportBtn = $("#motion-export"), rawBtn = $("#motion-export-raw");

  // One slot per person. A slot keeps its person from frame to frame.
  const slots = COLORS.map((color, index) => ({
    index, color, active: false, seen: 0, centre: null, lm: null,
    smoothed: null, groundY: 0, offsetX: 0, skin: null,
  }));
  const state = {
    visible: false, landmarker: null, loading: false, quality: "full",
    mirror: false, overlay: true, smooth: 0.5, look: "standard",
    skinName: null, skinCache: {}, customUrl: null, skinRequest: 0,
    lastVideoTime: -1,
    recording: false, frames: [], recStart: 0,
    fpsCount: 0, fpsAt: performance.now(), lastTick: performance.now(),
  };

  const source = new Source({
    stage, bar: $("#motion-sourcebar"), fileControls: true,
    onChange: async (kind) => {
      recordBtn.disabled = !kind;
      slots.forEach(dropSlot);
      if (!kind) { stopRecording(); setStatus("No source"); return; }
      if (kind === "file") source.video.play().catch(() => {});
      await ensureLandmarker();
    },
  });
  const video = source.video;

  function setStatus(text, live = false) {
    status.classList.toggle("live", live);
    status.firstElementChild.className = live ? "dot live" : "dot";
    status.lastElementChild.textContent = text;
  }

  // ---------- pose model ----------
  async function ensureLandmarker() {
    if (state.landmarker || state.loading) return;
    state.loading = true;
    setStatus("Loading capture model");
    try {
      const files = await FilesetResolver.forVisionTasks("vendor/mediapipe/wasm");
      const make = (delegate) => PoseLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: `models/pose_landmarker_${state.quality}.task`, delegate },
        runningMode: "VIDEO", numPoses: MAX_PEOPLE,
        minPoseDetectionConfidence: 0.4, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
      });
      try { state.landmarker = await make("GPU"); } catch { state.landmarker = await make("CPU"); }
    } catch (err) {
      console.error(err);
      setStatus("Capture model did not load");
      toast("The capture model did not load. Reload the page and try again.");
    }
    state.loading = false;
  }

  // ---------- 3D scene ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  viewport.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101010);
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 50);
  camera.position.set(0.9, 1.25, 4.6);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.92, 0);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.55;
  controls.minDistance = 1.5;
  controls.maxDistance = 9;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2a2a, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 1.9);
  key.position.set(2, 4, 3);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 0.6);
  rim.position.set(-3, 2, -3);
  scene.add(rim);
  const grid = new THREE.GridHelper(8, 16, 0x3a3a3a, 0x222222);
  scene.add(grid);
  const standardBackground = scene.background;
  const holo = new Hologram(renderer, scene, camera);
  const rings = slots.map((slot) => {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.435, 64), new THREE.MeshBasicMaterial({ color: slot.color.hex, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.002;
    ring.visible = slot.index === 0;
    scene.add(ring);
    return ring;
  });

  function resize() {
    const w = viewport.clientWidth, h = viewport.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    holo.resize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(viewport);

  // ---------- skins: one character per person ----------
  async function makeSkins(name) {
    if (name === "skeleton") return COLORS.map((c) => new SkeletonSkin(c.hex));
    if (name === "body") return COLORS.map((c) => new BodySkin(c.hex));
    if (name === "mesh") return Promise.all(COLORS.map((c) => RigSkin.load("models/xbot.glb", { tintJoints: true, color: c.hex })));
    return Promise.all(COLORS.map(() => RigSkin.load(state.customUrl)));
  }

  async function setSkin(name) {
    const request = ++state.skinRequest;
    try {
      state.skinCache[name] ??= await makeSkins(name);
    } catch (err) {
      console.error(err);
      toast(err.message === "no-rig"
        ? "That model has no humanoid rig that the app can read. Use a Mixamo or Ready Player Me character."
        : "The 3D model did not load. Use a .glb file.");
      if (name === "custom") { $("#custom-name").textContent = "Upload a .glb file"; state.customUrl = null; }
      return;
    }
    if (request !== state.skinRequest) return;     // a newer choice was made while this one loaded
    state.skinCache[name].forEach((skin) => holo.styleSkin(skin.group, state.look === "hologram"));
    const rigged = name === "mesh" || name === "custom";
    slots.forEach((slot) => {
      if (slot.skin) scene.remove(slot.skin.group);
      slot.skin = state.skinCache[name][slot.index];
      // A rigged character stands in its rest pose until a person appears.
      slot.skin.group.visible = slot.active || (rigged && slot.index === 0 && !slots.some((s) => s.active));
      slot.skin.group.position.x = slot.offsetX;
      scene.add(slot.skin.group);
    });
    state.skinName = name;
    $$("#skins .skin").forEach((b) => b.classList.toggle("on", b.dataset.skin === name));
    $("#skin-badge").textContent = `${SKIN_LABELS[name]}. Drag to rotate.`;
  }

  $("#skins").addEventListener("click", (e) => {
    const btn = e.target.closest(".skin");
    if (!btn) return;
    if (btn.dataset.skin === "custom" && (!state.customUrl || state.skinName === "custom")) $("#custom-file").click();
    else setSkin(btn.dataset.skin);
  });
  $("#custom-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (state.customUrl) URL.revokeObjectURL(state.customUrl);
    state.skinCache.custom?.forEach((skin) => skin.dispose());
    delete state.skinCache.custom;
    state.customUrl = URL.createObjectURL(file);
    $("#custom-name").textContent = file.name;
    setSkin("custom");
  });

  // ---------- settings ----------
  $("#mirror").addEventListener("change", (e) => {
    state.mirror = e.target.checked;
    frame.classList.toggle("mirror", state.mirror);
    slots.forEach((slot) => { slot.smoothed = null; });
  });
  $("#overlay").addEventListener("change", (e) => { state.overlay = e.target.checked; });
  segmented($("#look-seg"), (v) => {
    state.look = v;
    const on = v === "hologram";
    holo.setEnabled(on);
    grid.visible = !on;
    scene.background = on ? holo.background : standardBackground;
    Object.values(state.skinCache).flat().forEach((skin) => holo.styleSkin(skin.group, on));
    // The hologram needs a full body surface. The skeleton has none.
    if (on && state.skinName === "skeleton") setSkin("mesh");
  });
  $("#smooth").addEventListener("input", (e) => {
    state.smooth = Number(e.target.value);
    $("#smooth-val").textContent = state.smooth < 0.25 ? "Low" : state.smooth < 0.65 ? "Medium" : "High";
  });
  segmented($("#quality-seg"), async (v) => {
    state.quality = v;
    state.landmarker?.close();
    state.landmarker = null;
    if (source.active) await ensureLandmarker();
  });

  // ---------- recording and export ----------
  function stopRecording() {
    if (!state.recording) return;
    state.recording = false;
    recordBtn.lastElementChild.textContent = "Record motion";
    recordBtn.classList.remove("active");
    exportBtn.disabled = rawBtn.disabled = state.frames.length < 2;
    if (state.frames.length >= 2) toast("Recording complete. Select Export for Blender to save it.");
  }
  recordBtn.addEventListener("click", () => {
    if (state.recording) return stopRecording();
    state.recording = true;
    state.frames = [];
    state.recStart = performance.now();
    recordBtn.lastElementChild.textContent = "Stop recording";
    recordBtn.classList.add("active");
    exportBtn.disabled = rawBtn.disabled = true;
  });

  function download(text, type, name) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([text], { type }));
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

  // One .bvh file per person. Blender: File > Import > Motion Capture (.bvh).
  exportBtn.addEventListener("click", () => {
    const files = [];
    slots.forEach((slot) => {
      const samples = state.frames.filter((f) => f.people[slot.index]).map((f) => ({ t: f.t, points: f.people[slot.index] }));
      const bvh = buildBVH(samples);
      if (bvh) files.push({ bvh, person: slot.index + 1 });
    });
    if (!files.length) { toast("The recording has no person in it. Record again."); return; }
    const time = stamp();
    files.forEach(({ bvh, person }, i) => {
      const suffix = files.length > 1 ? `-person${person}` : "";
      setTimeout(() => download(bvh, "text/plain", `motion-${time}${suffix}.bvh`), i * 400);
    });
    toast(files.length > 1 ? "Saved one .bvh file for each person." : "Saved the .bvh file.");
  });
  rawBtn.addEventListener("click", () => {
    const seconds = state.frames.at(-1).t / 1000 || 1;
    download(JSON.stringify({
      format: "visiontest-motion", version: 2,
      frames_per_second: Math.round((state.frames.length / seconds) * 10) / 10,
      units: "metres",
      axes: "Origin at the hip centre of each person. x: to the right of the image. y: down. z: away from the camera.",
      joints: JOINT_NAMES,
      note: "Each frame has t (milliseconds) and people: a list with one entry per person. An entry is null when that person is not in view. A point is [x, y, z, visibility].",
      frames: state.frames,
    }), "application/json", `motion-${stamp()}.json`);
  });

  // ---------- people: keep the same slot for the same person ----------
  function dropSlot(slot) {
    slot.active = false;
    slot.smoothed = null;
    slot.lm = null;
    slot.centre = null;
    slot.points = null;
    holo.forget(slot.index);
    if (slot.skin) slot.skin.group.visible = false;
  }

  /** Returns a list: for each slot, the index of its detection (or -1). */
  function assign(centres, now) {
    const result = slots.map(() => -1);
    const live = slots.filter((s) => s.active && now - s.seen < LOST_AFTER);
    const d = (slot, i) => Math.hypot(slot.centre[0] - centres[i][0], slot.centre[1] - centres[i][1]);
    const free = new Set(centres.keys());
    if (live.length === 2 && centres.length === 2) {
      const straight = d(slots[0], 0) + d(slots[1], 1) <= d(slots[0], 1) + d(slots[1], 0);
      result[0] = straight ? 0 : 1;
      result[1] = straight ? 1 : 0;
      return result;
    }
    for (const slot of live) {
      let best = -1;
      for (const i of free) if (best < 0 || d(slot, i) < d(slot, best)) best = i;
      if (best >= 0) { result[slot.index] = best; free.delete(best); }
    }
    for (const slot of slots) {
      if (result[slot.index] >= 0 || !free.size) continue;
      const i = free.values().next().value;
      result[slot.index] = i;
      free.delete(i);
    }
    return result;
  }

  function applyPose(slot, world) {
    // MediaPipe: x right, y down, z away from camera. Three.js: y up, z toward the viewer.
    const target = world.map((_, i) => {
      const p = world[state.mirror ? SWAP[i] : i];
      return new THREE.Vector3(state.mirror ? -p.x : p.x, -p.y, -p.z);
    });
    const lowestOf = (pts) => Math.min(...[27, 28, 29, 30, 31, 32].map((i) => pts[i].y));
    if (!slot.smoothed) { slot.smoothed = target; slot.groundY = lowestOf(target); }
    else slot.smoothed.forEach((v, i) => v.lerp(target[i], 1 - state.smooth));
    slot.groundY += (lowestOf(slot.smoothed) - slot.groundY) * 0.2;
    if (slot.skin) {
      slot.skin.group.visible = true;
    }
    slot.points = slot.smoothed.map((v) => new THREE.Vector3(v.x, v.y - slot.groundY, v.z));
    slot.skin?.update(slot.points);
  }

  /** Two people stand side by side, in the same order as in the video. One person stands in the centre. */
  function placeCharacters() {
    const active = slots.filter((s) => s.active);
    const sorted = [...active].sort((a, b) => (a.centre[0] - b.centre[0]) * (state.mirror ? -1 : 1));
    sorted.forEach((slot, i) => {
      const goal = active.length === 2 ? (i === 0 ? -SIDE_OFFSET : SIDE_OFFSET) : 0;
      slot.offsetX += (goal - slot.offsetX) * 0.15;
      if (slot.skin) slot.skin.group.position.x = slot.offsetX;
    });
    slots.forEach((slot) => {
      rings[slot.index].visible = state.look !== "hologram" && (slot.active || (slot.index === 0 && !active.length));
      rings[slot.index].position.x = slot.active ? slot.offsetX : 0;
    });
  }

  function drawOverlay() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!state.overlay) return;
    ctx.lineCap = "round";
    for (const slot of slots) {
      const lm = slot.lm;
      if (!slot.active || !lm) continue;
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#ffffff";
      for (const [a, b] of LINKS) {
        if (lm[a].visibility < 0.3 || lm[b].visibility < 0.3) continue;
        ctx.beginPath();
        ctx.moveTo(lm[a].x * w, lm[a].y * h);
        ctx.lineTo(lm[b].x * w, lm[b].y * h);
        ctx.stroke();
      }
      ctx.fillStyle = slot.color.css;
      for (const i of [0, ...BODY_IDS]) {
        if (lm[i].visibility < 0.3) continue;
        ctx.beginPath();
        ctx.arc(lm[i].x * w, lm[i].y * h, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  const round = (v) => Math.round(v * 10000) / 10000;

  function tick() {
    requestAnimationFrame(tick);
    if (!state.visible) return;
    const now = performance.now();
    if (state.landmarker && source.active && video.readyState >= 2 && video.videoWidth
        && (source.kind === "camera" || video.currentTime !== state.lastVideoTime)) {
      state.lastVideoTime = video.currentTime;
      let result;
      try { result = state.landmarker.detectForVideo(video, now); } catch (err) { console.warn(err); }
      if (result) {
        const poses = result.landmarks || [], worlds = result.worldLandmarks || [];
        const centres = poses.map((lm) => [(lm[23].x + lm[24].x) / 2, (lm[23].y + lm[24].y) / 2]);
        const match = assign(centres, now);
        const recorded = slots.map(() => null);
        let visibility = 0;
        for (const slot of slots) {
          const i = match[slot.index];
          if (i < 0) {
            if (slot.active && now - slot.seen >= LOST_AFTER) dropSlot(slot);
            continue;
          }
          slot.active = true;
          slot.seen = now;
          slot.centre = centres[i];
          slot.lm = poses[i];
          applyPose(slot, worlds[i]);
          visibility = Math.max(visibility, BODY_IDS.reduce((sum, id) => sum + (worlds[i][id].visibility ?? 0), 0) / BODY_IDS.length);
          recorded[slot.index] = worlds[i].map((p) => [round(p.x), round(p.y), round(p.z), Math.round((p.visibility ?? 0) * 100) / 100]);
        }
        const count = slots.filter((s) => s.active).length;
        placeCharacters();
        drawOverlay();
        $("#mo-conf").firstChild.textContent = Math.round(visibility * 100);
        $("#mo-people").textContent = count;
        if (count) setStatus(state.recording ? "Recording" : count === 2 ? "Capturing 2 people" : "Capturing", true);
        else setStatus("No person in view");
        if (state.recording && recorded.some(Boolean)) state.frames.push({ t: Math.round(now - state.recStart), people: recorded });
      }
      state.fpsCount++;
    }
    if (now - state.fpsAt >= 1000) {
      $("#mo-fps").textContent = Math.round((state.fpsCount * 1000) / (now - state.fpsAt));
      state.fpsCount = 0;
      state.fpsAt = now;
      $("#mo-time").textContent = fmtTime(state.frames.length ? state.frames.at(-1).t / 1000 : 0);
    }
    controls.update();
    const dt = Math.min((now - state.lastTick) / 1000, 0.1);
    state.lastTick = now;
    if (state.look === "hologram") {
      for (const slot of slots) {
        if (!slot.active || !slot.points) continue;
        const offset = new THREE.Vector3(slot.offsetX, 0, 0);
        holo.emit(slot.index, slot.points.map((p) => p.clone().add(offset)), TRAIL_LINKS, dt);
      }
      holo.update(dt);
      holo.render();
    } else renderer.render(scene, camera);
  }

  setSkin("skeleton");
  tick();

  return {
    enter() { state.visible = true; resize(); if (source.kind === "file") video.play().catch(() => {}); },
    leave() {
      state.visible = false;
      stopRecording();
      if (source.kind === "camera") source.close();
      else if (source.kind === "file") video.pause();
    },
  };
}
