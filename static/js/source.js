// Video source: a camera (built-in or external) or an uploaded video file.
import { $, el, ICONS } from "./util.js";

const CAMERA_ERRORS = {
  NotAllowedError: "Camera access is blocked. Allow the camera in your browser, then try again.",
  NotFoundError: "No camera found. Connect a camera, or upload a video.",
  NotReadableError: "Another app is using the camera. Close that app, then try again.",
  OverconstrainedError: "That camera is not available. Select a different camera.",
};

export class Source {
  /**
   * stage: the .stage element (holds .frame with <video> and <canvas>)
   * bar: the .sourcebar element (source controls are added at its start)
   * onChange(kind): called with "camera", "file" or null
   */
  constructor({ stage, bar, onChange, fileControls = false }) {
    this.stage = stage;
    this.frame = $(".frame", stage);
    this.video = $("video", stage);
    this.onChange = onChange || (() => {});
    this.kind = null;
    this.fileName = "";
    this.stream = null;
    this.locked = false;

    // Empty state: one clear choice between camera and upload.
    this.error = el("p", { class: "err", hidden: true });
    this.fileInput = el("input", { type: "file", accept: "video/*", hidden: true });
    this.empty = el("div", { class: "stage-empty" },
      el("div", { class: "inner" },
        icon("div", "empty-icon", ICONS.camera),
        el("h3", { text: "Choose a video source" }),
        el("p", { text: "Use a camera for live video, or upload a recording to test." }),
        el("div", { class: "row" },
          iconBtn("btn primary", ICONS.camera, "Use camera", () => this.useCamera()),
          iconBtn("btn", ICONS.upload, "Upload video", () => this.fileInput.click()),
        ),
        this.error,
        el("p", { class: "hint", text: "You can also drop a video file here." }),
      ),
    );
    stage.append(this.empty, this.fileInput);
    this.fileInput.addEventListener("change", () => {
      if (this.fileInput.files[0]) this.useFile(this.fileInput.files[0]);
      this.fileInput.value = "";
    });

    // Controls in the bar below the stage.
    this.select = el("select", { class: "field", "aria-label": "Camera", hidden: true });
    this.select.addEventListener("change", () => this.useCamera(this.select.value));
    this.chipLabel = el("span");
    this.chip = el("div", { class: "chip", hidden: true }, icon("i", "", ICONS.film), this.chipLabel);
    this.chip.firstChild.style.display = "contents";
    this.playBtn = el("button", { class: "btn icon", hidden: true, title: "Play or pause", "aria-label": "Play or pause" });
    this.playBtn.addEventListener("click", () => (this.video.paused ? this.video.play() : this.video.pause()));
    this.closeBtn = el("button", { class: "btn ghost", hidden: true, text: "Change source", onclick: () => this.close() });
    bar.prepend(this.select, this.chip, this.playBtn, this.closeBtn);
    this.fileControls = fileControls;
    const syncPlay = () => { this.playBtn.innerHTML = this.video.paused ? ICONS.play : ICONS.pause; };
    this.video.addEventListener("play", syncPlay);
    this.video.addEventListener("pause", syncPlay);
    syncPlay();

    // Drag and drop.
    stage.addEventListener("dragover", (e) => { e.preventDefault(); if (!this.locked) stage.classList.add("dragover"); });
    stage.addEventListener("dragleave", () => stage.classList.remove("dragover"));
    stage.addEventListener("drop", (e) => {
      e.preventDefault();
      stage.classList.remove("dragover");
      const file = e.dataTransfer.files[0];
      if (file && !this.locked) this.useFile(file);
    });

    this.video.addEventListener("loadedmetadata", () => this.fit());
    new ResizeObserver(() => this.fit()).observe(stage);
    navigator.mediaDevices?.addEventListener?.("devicechange", () => this.kind === "camera" && this.listCameras());
  }

  get active() { return this.kind !== null; }

  /** Size the frame to the video shape, inside the stage. */
  fit() {
    const { videoWidth: vw, videoHeight: vh } = this.video;
    if (!vw || !vh) return;
    const sw = this.stage.clientWidth, sh = this.stage.clientHeight;
    const scale = Math.min(sw / vw, sh / vh);
    Object.assign(this.frame.style, {
      width: `${Math.round(vw * scale)}px`, height: `${Math.round(vh * scale)}px`,
      aspectRatio: "auto", maxWidth: "none", maxHeight: "none",
    });
  }

  showError(message) {
    this.error.textContent = message;
    this.error.hidden = !message;
  }

  async useCamera(deviceId) {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.showError("The camera needs a secure page. Open the app at http://localhost:8000.");
      return;
    }
    this.releaseMedia();
    const size = { width: { ideal: 1280 }, height: { ideal: 720 } };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: deviceId ? { deviceId: { exact: deviceId }, ...size } : size,
      });
    } catch (err) {
      this.setKind(null);
      this.showError(CAMERA_ERRORS[err.name] || `The camera did not start (${err.name}).`);
      return;
    }
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    await this.listCameras();
    this.setKind("camera");
  }

  async listCameras() {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    const current = this.stream?.getVideoTracks()[0]?.getSettings().deviceId;
    this.select.replaceChildren(
      ...devices.map((d, i) => el("option", { value: d.deviceId, text: d.label || `Camera ${i + 1}`, selected: d.deviceId === current })),
    );
  }

  async useFile(file) {
    if (!file.type.startsWith("video/")) {
      this.showError("That file is not a video. Use an MP4, MOV or WebM file.");
      return;
    }
    this.releaseMedia();
    this.fileName = file.name;
    this.video.src = URL.createObjectURL(file);
    try {
      await new Promise((resolve, reject) => {
        this.video.onloadeddata = resolve;
        this.video.onerror = reject;
      });
    } catch {
      this.setKind(null);
      this.showError("This browser cannot play that video. Try an MP4 (H.264) file.");
      return;
    }
    this.chipLabel.textContent = file.name;
    this.setKind("file");
  }

  releaseMedia() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.pause();
    if (this.video.src) URL.revokeObjectURL(this.video.src);
    this.video.srcObject = null;
    this.video.removeAttribute("src");
    this.video.load();
  }

  close() {
    this.releaseMedia();
    this.setKind(null);
  }

  setLocked(locked) {
    this.locked = locked;
    this.closeBtn.hidden = locked || !this.active;
  }

  setKind(kind) {
    this.kind = kind;
    if (kind) this.showError("");
    this.empty.hidden = !!kind;
    this.frame.hidden = !kind;
    this.select.hidden = kind !== "camera";
    this.chip.hidden = kind !== "file";
    this.playBtn.hidden = !(kind === "file" && this.fileControls);
    this.closeBtn.hidden = !kind || this.locked;
    this.fit();
    this.onChange(kind);
  }
}

function icon(tag, cls, svg) {
  const node = document.createElement(tag);
  node.className = cls;
  node.innerHTML = svg; // static icon markup only
  return node;
}

function iconBtn(cls, svg, label, onclick) {
  const btn = icon("button", cls, svg);
  btn.append(el("span", { text: label }));
  btn.addEventListener("click", onclick);
  return btn;
}
