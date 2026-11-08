"""OSINTboard backend: graph/media storage (SQLite) + maigret scan worker.

Storage: graphs live in a SQLite database and attachment files in a media
directory, both under OSINTBOARD_DATA_DIR (default backend/data; /app/data in
Docker, bind-mounted from ./osintboard-data). See the "Storage" section below.

Scans:

Demand-started by the Vite dev/preview server (vite.config.js
maigretLauncher): nothing listens on :8000 until the first /api request,
and the process exits itself after IDLE_TIMEOUT seconds without API
activity (the frontend's 2s poll keeps it alive during a scan). Results
persist to backend/results/<scan_id>/ on disk, so a later demand-start can
still serve results and PDFs of finished scans.
"""

import glob
import json
import os
import re
import shutil
import sqlite3
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, List
from urllib.parse import unquote

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent
RESULTS_DIR = BASE_DIR / "results"
RESULTS_DIR_REAL = os.path.realpath(RESULTS_DIR)
# Scan ids are minted server-side as uuid4().hex (32 lowercase hex chars). A
# request's {scan_id} is untrusted until it matches that shape exactly.
SCAN_ID_RE = re.compile(r"\A[0-9a-f]{32}\Z")
# maigret usernames: conservative allowlist. Also keeps the character set clear
# of glob metacharacters, since finish_scan globs report filenames by username.
USERNAME_RE = re.compile(r"\A[A-Za-z0-9._-]{1,64}\Z")
MAIGRET_BIN = BASE_DIR / ".venv" / "bin" / "maigret"

# Seconds without API activity before self-exit; 0 disables (prod systemd
# service keeps the worker up since nginx can't spawn processes).
IDLE_TIMEOUT = int(os.environ.get("OSINTBOARD_IDLE_TIMEOUT", "60"))
IDLE_POLL = 5

app = FastAPI(title="OSINTboard maigret backend")

# --- Uniform base-path contract (manifest.yml `route`) ----------------------
# nginx forwards the full URI (/osint/api/...), so rewrite the path in
# middleware to keep every route below root-relative. Middleware (rather than a
# router prefix) is used because the routes are declared decorator-style at
# module scope.
BASE_PATH = (os.environ.get("BASE_PATH", "/") or "/").rstrip("/")


@app.middleware("http")
async def strip_base_path(request: Request, call_next):
    if BASE_PATH and request.scope["path"].startswith(BASE_PATH):
        trimmed = request.scope["path"][len(BASE_PATH):] or "/"
        request.scope["path"] = trimmed
        request.scope["raw_path"] = trimmed.encode()
    return await call_next(request)

scans = {}      # scan_id -> public API record (mirrors scan.json)
processes = {}  # scan_id -> running Popen handle (not serializable)
last_activity = [time.monotonic()]


@app.middleware("http")
async def touch_last_activity(request, call_next):
    last_activity[0] = time.monotonic()
    return await call_next(request)


def _idle_watch():
    """Exit the process after IDLE_TIMEOUT without API activity."""
    while True:
        time.sleep(IDLE_POLL)
        if time.monotonic() - last_activity[0] > IDLE_TIMEOUT:
            # Don't leave an orphaned scan running after we exit.
            for proc in processes.values():
                proc.terminate()
            os._exit(0)


if IDLE_TIMEOUT > 0:
    threading.Thread(target=_idle_watch, daemon=True).start()


class ScanRequest(BaseModel):
    username: str


def _scan_dir(scan_id):
    """Resolve a request-supplied scan_id inside RESULTS_DIR, or None.

    scan_id arrives straight from the URL, so it must match the exact shape the
    server mints (uuid4().hex) before it is joined to RESULTS_DIR. The path is
    normalized before the prefix check, so `..` segments and symlinks cannot
    escape the results directory.
    """
    if not isinstance(scan_id, str) or not SCAN_ID_RE.match(scan_id):
        return None
    candidate = os.path.realpath(os.path.join(RESULTS_DIR_REAL, scan_id))
    if not candidate.startswith(RESULTS_DIR_REAL + os.sep):
        return None
    return Path(candidate)


def _record(scan_id):
    """Read the persisted record for a scan_id, or None."""
    scan_dir = _scan_dir(scan_id)
    if scan_dir is None:
        return None
    f = scan_dir / "scan.json"
    if not f.is_file():
        return None
    try:
        return json.loads(f.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def _persist(record):
    scan_dir = _scan_dir(record["id"])
    if scan_dir is None:
        # Ids are minted by this process, so a mismatch is a bug, not user input.
        raise ValueError(f"refusing to persist invalid scan id: {record['id']!r}")
    scan_dir.mkdir(parents=True, exist_ok=True)
    (scan_dir / "scan.json").write_text(json.dumps(record, indent=2))


def _public_record(record):
    """Shape a stored record into the API response."""
    if record is None:
        return None
    status = record.get("status")
    if status == "done":
        report_url = f"/api/maigret/report/{record['id']}"
        results_url = f"/api/maigret/results/{record['id']}"
    else:
        report_url = None
        results_url = None
    return {
        "id": record["id"],
        "username": record["username"],
        "status": status,
        "error": record.get("error"),
        "createdAt": record.get("createdAt"),
        "completedAt": record.get("completedAt"),
        "reportUrl": report_url,
        "resultsUrl": results_url,
    }


def finish_scan(scan_id):
    """Daemon thread: wait for the maigret process, finalize outputs."""
    process = processes.pop(scan_id, None)
    record = _record(scan_id)
    scan_dir = _scan_dir(scan_id)
    if process is None or record is None or scan_dir is None:
        return
    code = process.wait()

    now = datetime.now(timezone.utc).isoformat()

    if code == 0:
        # Rename outputs. Prefer the exact per-username files — a scan can
        # produce extra reports for similar usernames (sox0j, Soxoj1...).
        # Usernames are allowlisted in start_scan, but glob still keeps this
        # robust if a report is named for a variant of the requested handle.
        username = record.get("username", "")
        pdf_glob = f"{scan_dir}/reports/*.pdf"
        json_glob = f"{scan_dir}/reports/*_simple.json"
        exact_json = f"{scan_dir}/reports/report_{username}_simple.json"
        for pdf in glob.glob(pdf_glob):
            shutil.move(pdf, str(scan_dir / "report.pdf"))
            break
        for js in (
            glob.glob(exact_json) if username else []
        ) or glob.glob(json_glob):
            shutil.move(js, str(scan_dir / "results.json"))
            break
        record.update({"status": "done", "error": None, "completedAt": now})
    else:
        log_path = scan_dir / "scan.log"
        error = ""
        if log_path.exists():
            lines = log_path.read_text(errors="replace").strip().splitlines()
            error = "\n".join(lines[-5:])
        if not error:
            error = f"maigret exited with code {code}"
        record.update({"status": "error", "error": error, "completedAt": now})

    _persist(record)
    scans[scan_id] = _public_record(record)


@app.post("/api/maigret/scan")
def start_scan(req: ScanRequest):
    # Cap concurrent scans — maigret is CPU/network heavy and this API is public.
    if sum(1 for p in processes.values() if p.poll() is None) >= 3:
        raise HTTPException(status_code=429, detail="Too many scans in progress — try again shortly")
    username = req.username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="Username must not be empty")
    if len(username) > 64:
        raise HTTPException(status_code=400, detail="Username must be at most 64 characters")
    if not USERNAME_RE.match(username):
        raise HTTPException(
            status_code=400,
            detail="Username may only contain letters, digits, dot, underscore and hyphen",
        )

    scan_id = uuid.uuid4().hex
    scan_dir = _scan_dir(scan_id)
    scan_dir.mkdir(parents=True, exist_ok=True)

    record = {
        "id": scan_id,
        "username": username,
        "status": "running",
        "error": None,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "completedAt": None,
    }
    _persist(record)

    log_file = open(scan_dir / "scan.log", "wb")
    process = subprocess.Popen(
        [
            str(MAIGRET_BIN),
            "--no-autoupdate",
            "--no-color",
            "--no-progressbar",
            "-P",
            "-J",
            "simple",
            "--",
            username,
        ],
        cwd=str(scan_dir),
        stdout=log_file,
        stderr=subprocess.STDOUT,
    )
    processes[scan_id] = process

    scans[scan_id] = _public_record(record)

    threading.Thread(target=finish_scan, args=(scan_id,), daemon=True).start()

    return {"scanId": scan_id}


@app.get("/api/maigret/scan/{scan_id}")
def get_scan(scan_id: str):
    record = scans.get(scan_id)
    if record is None:
        persisted = _record(scan_id)
        if persisted is None:
            raise HTTPException(status_code=404, detail="Scan not found")
        if persisted.get("status") == "running":
            # Backend restarted mid-scan: the child process is gone.
            persisted.update(
                {
                    "status": "error",
                    "error": "Scan interrupted by server restart",
                    "completedAt": datetime.now(timezone.utc).isoformat(),
                }
            )
            _persist(persisted)
            record = _public_record(persisted)
        else:
            record = _public_record(persisted)
        scans[scan_id] = record
    return record


@app.get("/api/maigret/results/{scan_id}")
def get_results(scan_id: str):
    scan_dir = _scan_dir(scan_id)
    results_file = scan_dir / "results.json" if scan_dir else None
    if results_file is None or not results_file.is_file():
        raise HTTPException(status_code=404, detail="Results not found")
    return FileResponse(results_file, media_type="application/json")


@app.get("/api/maigret/report/{scan_id}")
def get_report(scan_id: str):
    scan_dir = _scan_dir(scan_id)
    report_file = scan_dir / "report.pdf" if scan_dir else None
    if report_file is None or not report_file.is_file():
        raise HTTPException(status_code=404, detail="Report not found")
    return FileResponse(report_file, media_type="application/pdf")


# =============================================================================
# Storage: graphs (SQLite) + media files
# =============================================================================
#
#   DATA_DIR/osintboard.db   graphs + media metadata
#   DATA_DIR/media/<id>      uploaded attachment files (raw bytes)
#
# A graph's nodes/edges are stored as JSON text; the frontend owns their shape.
# Attachments are uploaded separately and referenced from node data by id
# (`media[].fileId`), so graph documents stay small.

DATA_DIR = Path(os.environ.get("OSINTBOARD_DATA_DIR", BASE_DIR / "data"))
DB_PATH = DATA_DIR / "osintboard.db"
MEDIA_DIR = DATA_DIR / "media"
MEDIA_DIR_REAL = None  # set by _init_storage once the directory exists
MAX_MEDIA_BYTES = int(os.environ.get("OSINTBOARD_MAX_MEDIA_MB", "100")) * 1024 * 1024
# Unreferenced uploads are kept this long before cleanup, so attaching a file
# to a board that hasn't been saved yet (or undoing a removal) doesn't lose it.
MEDIA_GC_GRACE_SECONDS = 7 * 24 * 3600
# Graph and media ids are minted server-side as uuid4().hex.
ID_RE = SCAN_ID_RE
# Types shown in the browser (<img>/<video>/<audio>). Every other file type is
# accepted too, but only ever served as a download — an uploaded .html/.svg
# must never render as a page on this origin.
INLINE_MEDIA_KINDS = ("image", "video", "audio")
INLINE_BLOCKLIST = ("image/svg+xml",)  # SVG can carry script
MIME_RE = re.compile(r"\A[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\Z")
SCHEMA_VERSION = 1


def _now():
    return datetime.now(timezone.utc).isoformat()


def _db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def _query(fn):
    """Run fn(conn) in a transaction and close the connection."""
    conn = _db()
    try:
        with conn:
            return fn(conn)
    finally:
        conn.close()


def _init_storage():
    global MEDIA_DIR_REAL
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    MEDIA_DIR_REAL = os.path.realpath(MEDIA_DIR)

    def migrate(conn):
        conn.execute("PRAGMA journal_mode=WAL")
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        if version < 1:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS graphs (
                    id          TEXT PRIMARY KEY,
                    name        TEXT NOT NULL UNIQUE,
                    nodes       TEXT NOT NULL,
                    edges       TEXT NOT NULL,
                    created_at  TEXT NOT NULL,
                    saved_at    TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS media (
                    id          TEXT PRIMARY KEY,
                    name        TEXT NOT NULL,
                    mime        TEXT NOT NULL,
                    size        INTEGER NOT NULL,
                    created_at  TEXT NOT NULL
                );
                """
            )
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    _query(migrate)
    _gc_media()


def _media_path(media_id):
    """Resolve a request-supplied media id inside MEDIA_DIR, or None."""
    if not isinstance(media_id, str) or not ID_RE.match(media_id):
        return None
    candidate = os.path.realpath(os.path.join(MEDIA_DIR_REAL, media_id))
    if not candidate.startswith(MEDIA_DIR_REAL + os.sep):
        return None
    return Path(candidate)


def _referenced_media_ids(conn):
    ids = set()
    for row in conn.execute("SELECT nodes FROM graphs"):
        try:
            nodes = json.loads(row["nodes"])
        except json.JSONDecodeError:
            continue
        for node in nodes if isinstance(nodes, list) else []:
            data = node.get("data") if isinstance(node, dict) else None
            for item in (data or {}).get("media") or []:
                if isinstance(item, dict) and isinstance(item.get("fileId"), str):
                    ids.add(item["fileId"])
    return ids


def _gc_media():
    """Delete uploads no saved graph references once past the grace period."""
    cutoff = time.time() - MEDIA_GC_GRACE_SECONDS

    def collect(conn):
        referenced = _referenced_media_ids(conn)
        stale = []
        for row in conn.execute("SELECT id, created_at FROM media"):
            if row["id"] in referenced:
                continue
            try:
                created = datetime.fromisoformat(row["created_at"]).timestamp()
            except ValueError:
                created = 0
            if created < cutoff:
                stale.append(row["id"])
        for media_id in stale:
            conn.execute("DELETE FROM media WHERE id = ?", (media_id,))
        return stale

    for media_id in _query(collect):
        path = _media_path(media_id)
        if path is not None:
            path.unlink(missing_ok=True)
    # Interrupted uploads
    for part in MEDIA_DIR.glob("*.part"):
        if part.stat().st_mtime < cutoff:
            part.unlink(missing_ok=True)


class GraphIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    nodes: List[Any]
    edges: List[Any]


def _graph_summary(row):
    return {"id": row["id"], "name": row["name"], "savedAt": row["saved_at"]}


@app.get("/api/graphs")
def list_graphs():
    rows = _query(
        lambda c: c.execute(
            "SELECT id, name, saved_at FROM graphs ORDER BY saved_at DESC"
        ).fetchall()
    )
    return [_graph_summary(r) for r in rows]


@app.get("/api/graphs/{graph_id}")
def get_graph(graph_id: str):
    if not ID_RE.match(graph_id):
        raise HTTPException(status_code=404, detail="Graph not found")
    row = _query(
        lambda c: c.execute("SELECT * FROM graphs WHERE id = ?", (graph_id,)).fetchone()
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Graph not found")
    return {
        **_graph_summary(row),
        "nodes": json.loads(row["nodes"]),
        "edges": json.loads(row["edges"]),
    }


@app.post("/api/graphs")
def save_graph(graph: GraphIn):
    """Create, or overwrite the graph with the same name (names are unique)."""
    name = graph.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Graph name must not be empty")
    nodes = json.dumps(graph.nodes)
    edges = json.dumps(graph.edges)
    now = _now()

    def upsert(conn):
        row = conn.execute("SELECT id FROM graphs WHERE name = ?", (name,)).fetchone()
        if row:
            graph_id = row["id"]
            conn.execute(
                "UPDATE graphs SET nodes = ?, edges = ?, saved_at = ? WHERE id = ?",
                (nodes, edges, now, graph_id),
            )
        else:
            graph_id = uuid.uuid4().hex
            conn.execute(
                "INSERT INTO graphs (id, name, nodes, edges, created_at, saved_at)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (graph_id, name, nodes, edges, now, now),
            )
        return graph_id

    graph_id = _query(upsert)
    return {"id": graph_id, "name": name, "savedAt": now}


@app.delete("/api/graphs/{graph_id}")
def delete_graph(graph_id: str):
    if not ID_RE.match(graph_id):
        raise HTTPException(status_code=404, detail="Graph not found")
    deleted = _query(
        lambda c: c.execute("DELETE FROM graphs WHERE id = ?", (graph_id,)).rowcount
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="Graph not found")
    _gc_media()
    return {"ok": True}


def _clean_filename(raw):
    name = unquote(raw or "").replace("\\", "/").split("/")[-1]
    name = "".join(ch for ch in name if ch.isprintable()).strip()
    return name[:255] or "file"


@app.post("/api/media")
async def upload_media(request: Request):
    """Store one attachment (any file type). Body: raw file bytes;
    Content-Type: its MIME type; X-File-Name: URL-encoded original name."""
    mime = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
    if not MIME_RE.match(mime):
        mime = "application/octet-stream"
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_MEDIA_BYTES:
        raise HTTPException(status_code=413, detail="File is too large")

    name = _clean_filename(request.headers.get("x-file-name"))
    media_id = uuid.uuid4().hex
    path = _media_path(media_id)
    part = path.with_name(media_id + ".part")
    size = 0
    try:
        with open(part, "wb") as f:
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_MEDIA_BYTES:
                    raise HTTPException(status_code=413, detail="File is too large")
                f.write(chunk)
        if size == 0:
            raise HTTPException(status_code=400, detail="Empty file")
        os.replace(part, path)
    finally:
        part.unlink(missing_ok=True)

    _query(
        lambda c: c.execute(
            "INSERT INTO media (id, name, mime, size, created_at) VALUES (?, ?, ?, ?, ?)",
            (media_id, name, mime, size, _now()),
        )
    )
    return {"id": media_id, "name": name, "mime": mime, "size": size}


def _is_inline(mime):
    return mime.split("/")[0] in INLINE_MEDIA_KINDS and mime not in INLINE_BLOCKLIST


@app.get("/api/media/{media_id}")
def get_media(media_id: str, download: bool = False):
    """Serve an attachment. Images/video/audio display inline unless
    ?download=1; everything else is always a download."""
    path = _media_path(media_id)
    row = None
    if path is not None:
        row = _query(
            lambda c: c.execute("SELECT name, mime FROM media WHERE id = ?", (media_id,)).fetchone()
        )
    if row is None or not path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    inline = not download and _is_inline(row["mime"])
    return FileResponse(
        path,
        # Non-displayable types go out as opaque bytes
        media_type=row["mime"] if _is_inline(row["mime"]) else "application/octet-stream",
        filename=row["name"],
        content_disposition_type="inline" if inline else "attachment",
        headers={
            # Uploaded files are untrusted: never sniff, and if one is opened
            # directly (e.g. an SVG with script) run it in a sandbox.
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox",
            "Cache-Control": "private, max-age=31536000, immutable",
        },
    )


_init_storage()


@app.get("/api/health")
def health():
    """Uniform health endpoint (manifest `health`) for every app."""
    return {"ok": True, "app": "osintboard"}


if __name__ == "__main__":
    # PORT comes from the unit (manifest.yml); never hardcoded.
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", 4108)))
