"""People detection, tracking and counting.

YOLO finds people in each frame. Supervision (https://github.com/roboflow/supervision)
and its companion package Trackers give each person a stable ID (ByteTrack). Supervision counts line crossings (LineZone) and checks who is inside the drawn area (PolygonZone).
"""
from __future__ import annotations

import threading
import time
from pathlib import Path

import cv2
import numpy as np
import supervision as sv
from trackers import ByteTrackTracker
from ultralytics import YOLO

from . import store

MODEL_DIR = Path(__file__).resolve().parent.parent / "models"
MODEL_NAME = "yolo11n.pt"
PERSON_CLASS = 0
HEAT_W, HEAT_H = 48, 27          # heatmap grid (16:9)
LOST_AFTER = 2.0                 # seconds before a missing person leaves the zone
MIN_DWELL = 0.5                  # ignore zone visits shorter than this

_model: YOLO | None = None
_model_lock = threading.Lock()


def get_model() -> YOLO:
    """Load the detection model once. The first run downloads it (about 5 MB)."""
    global _model
    with _model_lock:
        if _model is None:
            MODEL_DIR.mkdir(parents=True, exist_ok=True)
            _model = YOLO(str(MODEL_DIR / MODEL_NAME))
            _model(np.zeros((360, 640, 3), dtype=np.uint8), verbose=False)  # warm up
        return _model


def model_ready() -> bool:
    return _model is not None


class TrackingSession:
    """State for one run: one camera stream or one uploaded video."""

    def __init__(self, name: str, source: str):
        self.id = store.create_session(name, source)
        self.t0 = time.monotonic()
        # Frames arrive at about 10 per second. A lost person keeps their ID for ~3 seconds.
        self.tracker = ByteTrackTracker(
            frame_rate=10, lost_track_buffer=30,
            track_activation_threshold=0.5, minimum_consecutive_frames=3,
        )
        self.conf = 0.35
        self.anchor = sv.Position.BOTTOM_CENTER
        self.line_norm: list | None = None
        self.zone_norm: list | None = None
        self.line: sv.LineZone | None = None
        self.zone: sv.PolygonZone | None = None
        self.frame_size: tuple[int, int] | None = None

        self.unique_ids: set[int] = set()
        self.in_count = 0
        self.out_count = 0
        self.zone_entries = 0
        self.dwells: list[float] = []
        self.peak = 0
        self.in_zone: dict[int, dict] = {}   # track id -> {"enter": t, "seen": t}
        self.heat = np.zeros((HEAT_H, HEAT_W), dtype=np.float32)

        self._last_t = 0.0
        self._last_sample = -1.0
        self._last_flush = 0.0
        self._samples: list[tuple] = []
        self._events: list[tuple] = []
        self._zone_now = 0
        self._current = 0

    # ---- configuration -------------------------------------------------
    def configure(self, cfg: dict) -> None:
        if "conf" in cfg:
            self.conf = float(min(max(cfg["conf"], 0.05), 0.95))
        if "anchor" in cfg:
            self.anchor = sv.Position.CENTER if cfg["anchor"] == "center" else sv.Position.BOTTOM_CENTER
            self.line = None
            self.zone = None
        if "line" in cfg:
            self.line_norm = cfg["line"] if cfg["line"] and len(cfg["line"]) == 2 else None
            self.line = None
        if "zone" in cfg:
            self.zone_norm = cfg["zone"] if cfg["zone"] and len(cfg["zone"]) >= 3 else None
            self.zone = None
            self._close_all_visits(self.elapsed())

    def _build_zones(self, w: int, h: int) -> None:
        if self.line is None and self.line_norm:
            (x1, y1), (x2, y2) = self.line_norm
            self.line = sv.LineZone(
                start=sv.Point(x1 * w, y1 * h),
                end=sv.Point(x2 * w, y2 * h),
                triggering_anchors=[self.anchor],
            )
        if self.zone is None and self.zone_norm:
            poly = np.array([[x * w, y * h] for x, y in self.zone_norm], dtype=np.int32)
            self.zone = sv.PolygonZone(polygon=poly, triggering_anchors=[self.anchor])

    # ---- per frame -----------------------------------------------------
    def elapsed(self) -> float:
        return time.monotonic() - self.t0

    def process(self, jpeg: bytes) -> dict | None:
        frame = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            return None
        h, w = frame.shape[:2]
        if self.frame_size != (w, h):
            self.frame_size = (w, h)
            self.line = None
            self.zone = None
        self._build_zones(w, h)

        t = self.elapsed()
        dt = min(t - self._last_t, 1.0)
        self._last_t = t
        started = time.perf_counter()

        model = get_model()
        with _model_lock:
            result = model(frame, classes=[PERSON_CLASS], conf=self.conf, imgsz=640, verbose=False)[0]
        det = sv.Detections.from_ultralytics(result)
        det = self.tracker.update(det)
        if det.tracker_id is not None:
            det = det[det.tracker_id >= 0]   # drop people not yet confirmed
        ids = [int(i) + 1 for i in det.tracker_id] if det.tracker_id is not None else []  # people are numbered from 1
        events: list[dict] = []

        for tid in ids:
            if tid not in self.unique_ids:
                self.unique_ids.add(tid)
                self._event(t, "new", tid, None, events)

        if self.line is not None and len(det):
            crossed_in, crossed_out = self.line.trigger(det)
            for tid, cin, cout in zip(ids, crossed_in, crossed_out):
                if cin:
                    self.in_count += 1
                    self._event(t, "in", tid, None, events)
                if cout:
                    self.out_count += 1
                    self._event(t, "out", tid, None, events)

        inside = np.zeros(len(det), dtype=bool)
        if self.zone is not None:
            if len(det):
                inside = self.zone.trigger(det)
            self._update_zone(t, ids, inside, events)

        anchors = det.get_anchors_coordinates(sv.Position.BOTTOM_CENTER) if len(det) else np.empty((0, 2))
        for ax, ay in anchors:
            gx = min(max(int(ax / w * HEAT_W), 0), HEAT_W - 1)
            gy = min(max(int(ay / h * HEAT_H), 0), HEAT_H - 1)
            self.heat[gy, gx] += dt

        self._current = len(det)
        self._zone_now = len(self.in_zone)
        self.peak = max(self.peak, self._current)
        if t - self._last_sample >= 1.0:
            self._last_sample = t
            self._samples.append((round(t, 2), self._current, self._zone_now))
        if t - self._last_flush >= 5.0:
            self.flush()

        people = [
            {
                "id": tid,
                "box": [float(b[0] / w), float(b[1] / h), float(b[2] / w), float(b[3] / h)],
                "conf": round(float(c), 2),
                "zone": bool(z),
            }
            for tid, b, c, z in zip(ids, det.xyxy, det.confidence, inside)
        ]
        return {
            "type": "result",
            "people": people,
            "stats": self.totals(),
            "events": events,
            "ms": round((time.perf_counter() - started) * 1000),
        }

    def _event(self, t: float, kind: str, tid: int, value: float | None, out: list[dict]) -> None:
        self._events.append((round(t, 2), kind, tid, value))
        out.append({"t": round(t, 1), "kind": kind, "id": tid, "value": value})

    def _update_zone(self, t: float, ids: list[int], inside, events: list[dict]) -> None:
        visible = dict(zip(ids, inside))
        for tid, is_in in visible.items():
            if is_in:
                if tid not in self.in_zone:
                    self.in_zone[tid] = {"enter": t, "seen": t}
                    self.zone_entries += 1
                    self._event(t, "zone_enter", tid, None, events)
                else:
                    self.in_zone[tid]["seen"] = t
        for tid in list(self.in_zone):
            visit = self.in_zone[tid]
            left = tid in visible and not visible[tid]
            lost = tid not in visible and t - visit["seen"] > LOST_AFTER
            if left or lost:
                self._close_visit(tid, t if left else visit["seen"], events)

    def _close_visit(self, tid: int, t: float, events: list[dict]) -> None:
        visit = self.in_zone.pop(tid)
        dwell = t - visit["enter"]
        if dwell >= MIN_DWELL:
            self.dwells.append(dwell)
            self._event(t, "zone_exit", tid, round(dwell, 2), events)
        else:
            self.zone_entries = max(self.zone_entries - 1, 0)

    def _close_all_visits(self, t: float) -> None:
        for tid in list(self.in_zone):
            self._close_visit(tid, self.in_zone[tid]["seen"], [])

    # ---- totals and storage --------------------------------------------
    def totals(self) -> dict:
        return {
            "elapsed": round(self.elapsed(), 1),
            "current": self._current,
            "unique": len(self.unique_ids),
            "in": self.in_count,
            "out": self.out_count,
            "zone_now": self._zone_now,
            "zone_entries": self.zone_entries,
            "avg_dwell": round(float(np.mean(self.dwells)), 1) if self.dwells else 0,
            "peak": self.peak,
        }

    def flush(self, ended: bool = False) -> None:
        self._last_flush = self.elapsed()
        store.add_rows(self.id, self._samples, self._events)
        self._samples, self._events = [], []
        heat = np.round(self.heat, 2).tolist() if ended else None
        store.update_session(self.id, self.totals(), heatmap=heat, ended=ended)

    def finish(self) -> dict:
        self._close_all_visits(self.elapsed())
        self._current = 0
        self._zone_now = 0
        self.flush(ended=True)
        return self.totals()
