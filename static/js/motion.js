// Motion capture: finds 33 body points in the video (MediaPipe Pose, runs in
// the browser) and applies them to a 3D character (three.js).
import * as THREE from "/vendor/three/three.module.js";
import { OrbitControls } from "/vendor/three/OrbitControls.js";
import { FilesetResolver, PoseLandmarker } from "/vendor/mediapipe/vision_bundle.mjs";
import { $, $$, fmtTime, toast, segmented } from "./util.js";
import { Source } from "./source.js";
import { SkeletonSkin, BodySkin, RigSkin } from "./avatar.js";

const CORAL = "#ff5a52";
const JOINT_NAMES = [
  "nose", "left_eye_inner", "left_eye", "left_eye_outer", "right_eye_inner", "right_eye", "right_eye_outer",
  "left_ear", "right_ear", "mouth_left", "mouth_right", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
  "left_wrist", "right_wrist", "left_pinky", "right_pinky", "left_index", "right_index", "left_thumb", "right_thumb",
  "left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle", "left_heel", "right_heel",
  "left_foot_index", "right_foot_index",
];
const LINKS = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [27, 31], [28, 32], [27, 29], [28, 30]];
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
  const recordBtn = $("#motion-record"), exportBtn = $("#motion-export");

  const state = {
    visible: false, landmarker: null, loading: false, quality: "full",
    mirror: false, overlay: true, smooth: 0.5,
    skinName: "skeleton", skin: null, skins: {}, customUrl: null,
    smoothed: null, groundY: 0, lastVideoTime: -1,
    recording: false, frames: [], recStart: 0,
    fpsCount: 0, fpsAt: performance.now(),
  };

  const source = new Source({
    stage, bar: $("#motion-sourcebar"), fileControls: true,
    onChange: async (kind) => {
      recordBtn.disabled = !kind;
      state.smoothed = null;
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
      const files = await FilesetResolver.forVisionTasks("/vendor/mediapipe/wasm");
      const make = (delegate) => PoseLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: `/models/pose_landmarker_${state.quality}.task`, delegate },
        runningMode: "VIDEO", numPoses: 1,
        minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
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
  camera.position.set(0.9, 1.25, 4.3);
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
  const rim = new THREE.DirectionalLight(0xff8a84, 0.8);
  rim.position.set(-3, 2, -3);
  scene.add(rim);
  const grid = new THREE.GridHelper(8, 16, 0x3a3a3a, 0x222222);
  scene.add(grid);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.515, 64), new THREE.MeshBasicMaterial({ color: 0xff5a52, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.002;
  scene.add(ring);

  function resize() {
    const w = viewport.clientWidth, h = viewport.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(viewport);

  // ---------- skins ----------
  async function setSkin(name) {
    try {
      if (!state.skins[name]) {
        if (name === "skeleton") state.skins[name] = new SkeletonSkin();
        else if (name === "body") state.skins[name] = new BodySkin();
        else if (name === "mesh") state.skins[name] = await RigSkin.load("/models/xbot.glb", { tintJoints: true });
        else if (name === "custom") state.skins[name] = await RigSkin.load(state.customUrl);
      }
    } catch (err) {
      console.error(err);
      toast(err.message === "no-rig"
        ? "That model has no humanoid rig that the app can read. Use a Mixamo or Ready Player Me character."
        : "The 3D model did not load. Use a .glb file.");
      if (name === "custom") { $("#custom-name").textContent = "Upload a .glb file"; state.customUrl = null; }
      return;
    }
    if (state.skin) scene.remove(state.skin.group);
    state.skin = state.skins[name];
    state.skinName = name;
    state.skin.group.visible = name === "mesh" || name === "custom" || !!state.smoothed;
    scene.add(state.skin.group);
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
    state.skins.custom?.dispose();
    delete state.skins.custom;
    state.customUrl = URL.createObjectURL(file);
    $("#custom-name").textContent = file.name;
    setSkin("custom");
  });

  // ---------- settings ----------
  $("#mirror").addEventListener("change", (e) => {
    state.mirror = e.target.checked;
    frame.classList.toggle("mirror", state.mirror);
    state.smoothed = null;
  });
  $("#overlay").addEventListener("change", (e) => { state.overlay = e.target.checked; });
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

  // ---------- recording ----------
  function stopRecording() {
    if (!state.recording) return;
    state.recording = false;
    recordBtn.lastElementChild.textContent = "Record motion";
    recordBtn.classList.remove("active");
    exportBtn.disabled = !state.frames.length;
    if (state.frames.length) toast(`Recorded ${state.frames.length} frames. Select Export to save the file.`);
  }
  recordBtn.addEventListener("click", () => {
    if (state.recording) return stopRecording();
    state.recording = true;
    state.frames = [];
    state.recStart = performance.now();
    recordBtn.lastElementChild.textContent = "Stop recording";
    recordBtn.classList.add("active");
    exportBtn.disabled = true;
  });
  exportBtn.addEventListener("click", () => {
    const seconds = state.frames.at(-1).t / 1000 || 1;
    const data = {
      format: "visiontest-motion", version: 1,
      frames_per_second: Math.round((state.frames.length / seconds) * 10) / 10,
      units: "metres",
      axes: "Origin at the hip centre. x: to the right of the image. y: down. z: away from the camera.",
      joints: JOINT_NAMES,
      frames: state.frames,
    };
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
    link.download = `motion-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });

  // ---------- per frame ----------
  function applyPose(world) {
    // MediaPipe: x right, y down, z away from camera. Three.js: y up, z toward the viewer.
    const target = world.map((_, i) => {
      const p = world[state.mirror ? SWAP[i] : i];
      return new THREE.Vector3(state.mirror ? -p.x : p.x, -p.y, -p.z);
    });
    if (!state.smoothed) state.smoothed = target;
    else state.smoothed.forEach((v, i) => v.lerp(target[i], 1 - state.smooth));

    const lowest = Math.min(...[27, 28, 29, 30, 31, 32].map((i) => state.smoothed[i].y));
    state.groundY += (lowest - state.groundY) * 0.2;
    const points = state.smoothed.map((v) => new THREE.Vector3(v.x, v.y - state.groundY, v.z));
    if (state.skin) {
      state.skin.group.visible = true;
      state.skin.update(points);
    }
  }

  function drawOverlay(lm) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!lm || !state.overlay) return;
    ctx.lineCap = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#ffffff";
    for (const [a, b] of LINKS) {
      if (lm[a].visibility < 0.3 || lm[b].visibility < 0.3) continue;
      ctx.beginPath();
      ctx.moveTo(lm[a].x * w, lm[a].y * h);
      ctx.lineTo(lm[b].x * w, lm[b].y * h);
      ctx.stroke();
    }
    ctx.fillStyle = CORAL;
    for (const i of [0, ...BODY_IDS]) {
      if (lm[i].visibility < 0.3) continue;
      ctx.beginPath();
      ctx.arc(lm[i].x * w, lm[i].y * h, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function tick() {
    requestAnimationFrame(tick);
    if (!state.visible) return;
    const now = performance.now();
    if (state.landmarker && source.active && video.readyState >= 2 && video.videoWidth
        && (source.kind === "camera" || video.currentTime !== state.lastVideoTime)) {
      state.lastVideoTime = video.currentTime;
      let result;
      try { result = state.landmarker.detectForVideo(video, now); } catch (err) { console.warn(err); }
      const lm = result?.landmarks?.[0], world = result?.worldLandmarks?.[0];
      drawOverlay(lm);
      if (world) {
        applyPose(world);
        const vis = BODY_IDS.reduce((sum, i) => sum + (world[i].visibility ?? 0), 0) / BODY_IDS.length;
        $("#mo-conf").firstChild.textContent = Math.round(vis * 100);
        setStatus(state.recording ? "Recording" : "Capturing", true);
        if (state.recording) {
          state.frames.push({
            t: Math.round(now - state.recStart),
            points: world.map((p) => [round(p.x), round(p.y), round(p.z), Math.round((p.visibility ?? 0) * 100) / 100]),
          });
        }
      } else if (result) {
        setStatus("No person in view");
        $("#mo-conf").firstChild.textContent = 0;
      }
      state.fpsCount++;
    }
    if (now - state.fpsAt >= 1000) {
      $("#mo-fps").textContent = Math.round((state.fpsCount * 1000) / (now - state.fpsAt));
      state.fpsCount = 0;
      state.fpsAt = now;
      $("#mo-frames").textContent = state.frames.length;
      $("#mo-time").textContent = fmtTime(state.frames.length ? state.frames.at(-1).t / 1000 : 0);
    }
    controls.update();
    renderer.render(scene, camera);
  }
  const round = (v) => Math.round(v * 10000) / 10000;

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
