"""SQLite storage for tracking sessions. One file, no server needed."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "visiontest.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    started_at REAL NOT NULL,
    ended_at REAL,
    duration REAL DEFAULT 0,
    unique_count INTEGER DEFAULT 0,
    in_count INTEGER DEFAULT 0,
    out_count INTEGER DEFAULT 0,
    zone_entries INTEGER DEFAULT 0,
    avg_dwell REAL DEFAULT 0,
    peak INTEGER DEFAULT 0,
    heatmap TEXT
);
CREATE TABLE IF NOT EXISTS samples (
    session_id INTEGER NOT NULL,
    t REAL NOT NULL,
    current INTEGER NOT NULL,
    zone_now INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    session_id INTEGER NOT NULL,
    t REAL NOT NULL,
    kind TEXT NOT NULL,
    track_id INTEGER,
    value REAL
);
CREATE INDEX IF NOT EXISTS idx_samples_session ON samples(session_id);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
"""

_lock = threading.Lock()


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


_conn = _connect()
_conn.executescript(SCHEMA)
# Sessions left open by a crash or a closed browser tab: mark them as ended.
_conn.execute("UPDATE sessions SET ended_at = started_at + duration WHERE ended_at IS NULL")
_conn.commit()


def create_session(name: str, source: str) -> int:
    with _lock:
        cur = _conn.execute(
            "INSERT INTO sessions (name, source, started_at) VALUES (?, ?, ?)",
            (name, source, time.time()),
        )
        _conn.commit()
        return int(cur.lastrowid)


def add_rows(session_id: int, samples: list[tuple], events: list[tuple]) -> None:
    """samples: (t, current, zone_now). events: (t, kind, track_id, value)."""
    if not samples and not events:
        return
    with _lock:
        _conn.executemany(
            "INSERT INTO samples VALUES (?, ?, ?, ?)",
            [(session_id, *s) for s in samples],
        )
        _conn.executemany(
            "INSERT INTO events VALUES (?, ?, ?, ?, ?)",
            [(session_id, *e) for e in events],
        )
        _conn.commit()


def update_session(session_id: int, totals: dict, heatmap: list | None = None, ended: bool = False) -> None:
    with _lock:
        _conn.execute(
            """UPDATE sessions SET duration=?, unique_count=?, in_count=?, out_count=?,
               zone_entries=?, avg_dwell=?, peak=? WHERE id=?""",
            (
                totals["elapsed"], totals["unique"], totals["in"], totals["out"],
                totals["zone_entries"], totals["avg_dwell"], totals["peak"], session_id,
            ),
        )
        if heatmap is not None:
            _conn.execute("UPDATE sessions SET heatmap=? WHERE id=?", (json.dumps(heatmap), session_id))
        if ended:
            _conn.execute("UPDATE sessions SET ended_at=? WHERE id=?", (time.time(), session_id))
        _conn.commit()


def _session_dict(row: sqlite3.Row, with_heatmap: bool = False) -> dict:
    d = dict(row)
    heat = d.pop("heatmap", None)
    if with_heatmap:
        d["heatmap"] = json.loads(heat) if heat else None
    d["live"] = d["ended_at"] is None
    return d


def list_sessions() -> list[dict]:
    with _lock:
        rows = _conn.execute("SELECT * FROM sessions ORDER BY started_at DESC").fetchall()
    return [_session_dict(r) for r in rows]


def get_session(session_id: int) -> dict | None:
    with _lock:
        row = _conn.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
        if row is None:
            return None
        samples = _conn.execute(
            "SELECT t, current, zone_now FROM samples WHERE session_id=? ORDER BY t", (session_id,)
        ).fetchall()
        events = _conn.execute(
            "SELECT t, kind, track_id, value FROM events WHERE session_id=? ORDER BY t", (session_id,)
        ).fetchall()
    d = _session_dict(row, with_heatmap=True)
    d["samples"] = [list(s) for s in samples]
    d["events"] = [dict(e) for e in events]
    return d


def delete_session(session_id: int) -> None:
    with _lock:
        _conn.execute("DELETE FROM samples WHERE session_id=?", (session_id,))
        _conn.execute("DELETE FROM events WHERE session_id=?", (session_id,))
        _conn.execute("DELETE FROM sessions WHERE id=?", (session_id,))
        _conn.commit()


def overview() -> dict:
    with _lock:
        row = _conn.execute(
            """SELECT COUNT(*) AS sessions,
                      COALESCE(SUM(unique_count), 0) AS unique_count,
                      COALESCE(SUM(in_count), 0) AS in_count,
                      COALESCE(SUM(out_count), 0) AS out_count,
                      COALESCE(SUM(zone_entries), 0) AS zone_entries,
                      COALESCE(MAX(peak), 0) AS peak,
                      COALESCE(SUM(duration), 0) AS duration
               FROM sessions"""
        ).fetchone()
        dwell = _conn.execute("SELECT AVG(value) FROM events WHERE kind='zone_exit'").fetchone()[0]
    d = dict(row)
    d["avg_dwell"] = dwell or 0
    return d
