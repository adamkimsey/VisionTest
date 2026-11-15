"""VisionTest server. Serves the web app and runs the people tracking."""
from __future__ import annotations

import asyncio
import csv
import io
import json
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from . import store, tracker

STATIC = Path(__file__).resolve().parent.parent / "static"

app = FastAPI(title="VisionTest")


@app.on_event("startup")
def _load_model_in_background() -> None:
    threading.Thread(target=tracker.get_model, daemon=True).start()


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "model_ready": tracker.model_ready()}


@app.get("/api/overview")
def overview() -> dict:
    return store.overview()


@app.get("/api/sessions")
def sessions() -> list[dict]:
    return store.list_sessions()


@app.get("/api/sessions/{session_id}")
def session(session_id: int) -> dict:
    data = store.get_session(session_id)
    if data is None:
        raise HTTPException(404, "Session not found")
    return data


@app.delete("/api/sessions/{session_id}")
def delete_session(session_id: int) -> dict:
    store.delete_session(session_id)
    return {"ok": True}


@app.get("/api/sessions/{session_id}/export.csv")
def export_csv(session_id: int) -> Response:
    data = store.get_session(session_id)
    if data is None:
        raise HTTPException(404, "Session not found")
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["time_seconds", "event", "person_id", "dwell_seconds"])
    for e in data["events"]:
        writer.writerow([e["t"], e["kind"], e["track_id"], e["value"] if e["value"] is not None else ""])
    return Response(
        buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="session-{session_id}.csv"'},
    )


@app.websocket("/ws/track")
async def track(ws: WebSocket) -> None:
    """Text messages carry settings. Binary messages carry one JPEG frame each."""
    await ws.accept()
    session: tracker.TrackingSession | None = None
    pending_cfg: dict = {}
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if msg.get("text") is not None:
                data = json.loads(msg["text"])
                kind = data.get("type")
                if kind == "start":
                    if session is not None:
                        session.finish()
                    await asyncio.to_thread(tracker.get_model)
                    session = tracker.TrackingSession(
                        str(data.get("name") or "Untitled session")[:80],
                        "upload" if data.get("source") == "upload" else "camera",
                    )
                    session.configure(pending_cfg)
                    await ws.send_json({"type": "started", "session_id": session.id})
                elif kind == "config":
                    pending_cfg.update({k: v for k, v in data.items() if k != "type"})
                    if session is not None:
                        session.configure(data)
                elif kind == "stop" and session is not None:
                    totals = await asyncio.to_thread(session.finish)
                    await ws.send_json({"type": "stopped", "session_id": session.id, "stats": totals})
                    session = None
            elif msg.get("bytes") is not None and session is not None:
                result = await asyncio.to_thread(session.process, msg["bytes"])
                if result is not None:
                    await ws.send_json(result)
    except WebSocketDisconnect:
        pass
    finally:
        if session is not None:
            session.finish()


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


app.mount("/", StaticFiles(directory=STATIC), name="static")
