# 🕵️ OSINTboard

**Intelligence Graph Canvas** — a drag-and-drop OSINT investigation board for building visual link-analysis graphs. Drop nodes, draw connections, and map out relationships between people, phone numbers, emails, URLs, and more — all on a clean CAD-style black canvas.

![screenshot](https://img.shields.io/badge/status-active-brightgreen)

**Local-first and self-hosted** — all boards are stored in your browser; no account, cloud service, or telemetry.

---

## Features

- 🎨 **CAD-style black canvas** — white-on-dark theme, grid snapping, minimap
- 🧩 **16 node types** — Person, Phone, Email, Address, Place, Social Media, URL, Company, Username, IP, External Link, Note, Date, Document, Timeline, Media
- 🖱️ **Drag & drop** — grab nodes from the sidebar, drop them anywhere on the canvas
- 🔗 **Link analysis** — drag between any of the 4 connection points (top, right, bottom, left) to draw arrowed lines; every point works as both input and output
- 🏷️ **Edge labels** — double-click a connection to name the relationship ("works at", "owns", "called"…)
- ↪️ **Reconnect** — select a connection and drag either end to another point or node
- ⇄ **Auto / Manual routing** — Auto attaches connections to the facing sides of nodes as you move them; Manual keeps the points you chose
- ✏️ **Inline editing** — double-click any node to edit its label
- 🕵️ **Maigret username scanning** — right-click a Username node → **Run Scan** to check the handle across ~500 sites; results render in-app with account badges, profile links, tags, and a downloadable PDF report
- 🎬 **YouTube embedding** — paste a YouTube URL into an External Link node to render a live video player
- 💾 **Save/Load** — persist investigations to browser localStorage, switch between multiple graphs
- 🗑️ **Delete support** — select nodes/edges and press Delete or Backspace
- 🧭 **Navigation** — scroll to zoom, drag to pan, minimap, zoom controls

---

## Quick Start

```bash
git clone https://github.com/PixlPixlPixl/OSINTboard.git
cd OSINTboard
npm install

# Backend (Python 3.12, venv kept inside the repo). Requires `uv`:
uv venv --relocatable --python /usr/bin/python3 backend/.venv
uv pip install --python backend/.venv/bin/python -r backend/requirements.txt

npm run dev
```

Open the URL Vite prints (e.g. `http://localhost:5173/OSINTboard/`).

The maigret backend is **demand-started**: nothing runs on port 8000 until you click **Run Scan** on a username node — Vite spawns the worker on the first `/api` request, and it exits itself after ~60s idle. (No separate `uvicorn` command to run during development.)

---

## Docker Compose

Prefer containers? The whole app (nginx + built frontend + maigret backend) can run with Docker Compose — no Node, Python, or `uv` needed on the host.

```bash
git clone https://github.com/PixlPixlPixl/OSINTboard.git
cd OSINTboard

docker compose up -d --build
```

Open **http://localhost:8080** (override with `OSINTBOARD_PORT`, e.g. `OSINTBOARD_PORT=9000 docker compose up -d`).

The frontend is built from source in a Node stage and served by nginx; `/api/` is proxied to the FastAPI/maigret container. Unlike the dev server, the backend runs continuously (`OSINTBOARD_IDLE_TIMEOUT=0`) and restarts with the container.

Copy `.env.example` to `.env` to override `OSINTBOARD_PORT`.

Useful commands:

```bash
docker compose logs -f          # follow both containers
docker compose ps               # status + health
docker compose down             # stop (keeps scan results)
docker compose down -v          # stop and delete the results volume
```

Scan results and PDFs persist in the `osintboard-results` named volume across restarts and rebuilds. To upgrade after pulling changes, run `docker compose up -d --build` again.

---

## Usage

### Building a Graph

1. **Add nodes** — drag a node type from the sidebar onto the canvas
2. **Connect nodes** — hover a node to reveal its 4 connection points, then drag from any point to a point on another node (the arrow points to where you release)
   - Double-click a connection to add or edit its label
   - Select a connection and drag its end to re-attach it
   - Toggle **⇄ Auto / ✋ Manual** in the top-left toolbar to switch connection routing
3. **Label nodes** — double-click a node to type your intelligence data
4. **Arrange** — drag nodes to reposition; they snap to a 10px grid
5. **Zoom & pan** — scroll to zoom, drag the canvas background to pan

### Running a Maigret Scan

1. Drop a **Username** node, double-click it, and enter the handle (e.g. `soxoj`)
2. **Right-click** the node → **▶ Run Scan**
3. The node shows `Scanning…` — a full scan of ~500 top sites takes 2–5 minutes
4. When done, a **📄 View Results** button appears — click it for the in-app report: account cards with site name, status badge (e.g. *Claimed*), profile link, tags, and extracted identity fields
5. **⬇ Download PDF** in the popup downloads the generated PDF report

> Scan results and PDFs are stored per scan under `backend/results/<scan_id>/` (gitignored). Right-click the canvas (or long-press on mobile) for the quick-search palette; right-clicking a non-username node shows no menu.

### Saving Your Work

Click **Save** in the sidebar, give your graph a name, and it's persisted in your browser's localStorage. **Load** to pick from saved investigations. **New** clears the canvas for a fresh board.

### YouTube Links

Drop an **External Link** node, double-click it, and paste a YouTube URL. The node expands and renders a playable embedded video — useful for keeping video evidence or interviews inline with your investigation graph.

### Node Types

| Node | Color | Purpose |
|------|-------|---------|
| 👤 Person / Contact | Blue | Person of interest |
| 📞 Phone Number | Green | Phone intelligence |
| ✉️ Email Address | Orange | Email intelligence |
| 📍 Address | Red | Physical address |
| 🌍 Place | Light blue | Location, venue, or landmark |
| 📱 Social Media | Purple | Social profile |
| 🔗 URL / Website | Cyan | Website or link |
| 🏢 Company | Yellow | Organization |
| 👤 Username | Lime | Online handle — right-click to run a Maigret scan |
| 🖥️ IP Address | Gray | IP intelligence |
| 🔗 External Link | Coral | URL — YouTube embeds a player |
| 📝 Note | White | Investigator note |
| 📅 Date / Event | Pink | Date or event marker |
| 📄 Document | Silver | Document reference |
| 📊 Timeline | Teal | Chronological timeline with dates |
| 🖼️ Media | Purple | Photo, video, and audio gallery |

---

## Project Structure

```
backend/
├── main.py            # FastAPI scan worker: run scan, store results + PDF
├── requirements.txt   # maigret[pdf]==0.6.6, fastapi, uvicorn
└── Dockerfile         # Python 3.12 + venv + maigret image
src/
├── components/
│   ├── Canvas.jsx         # React Flow canvas, drag/drop, connections, scan polling
│   ├── OSINTNode.jsx      # Custom node (YouTube embed, scan status, View Results)
│   ├── NodeContextMenu.jsx# Right-click menu for username nodes
│   ├── MaigretReport.jsx  # In-app scan results popup + PDF download
│   ├── GraphModal.jsx     # Save/Load/Delete modal dialogs
│   ├── Sidebar.jsx        # Node palette + graph management buttons
│   └── ...
├── data/
│   ├── graphStore.js      # localStorage CRUD (save/load/list/delete)
│   └── nodeTypes.js       # Node type definitions (icon, color, label)
├── utils/
│   └── maigretApi.js      # /api/maigret client (startScan, getScan, getResults)
├── App.jsx                # Root layout, modal state
├── App.css                # All dark-theme CAD styles
└── main.jsx               # Entry point
vite.config.js             # /api proxy + maigret launcher plugin (dev & preview)
Dockerfile                 # frontend build stage + nginx runtime image
nginx.conf                 # static app serving + /api reverse proxy
docker-compose.yml         # web + backend services
```

---

## Tech Stack

- **[React 19](https://react.dev)** — UI framework
- **[Vite](https://vite.dev)** — Dev server & build tool (serves the app and demand-starts the scan worker)
- **[React Flow](https://reactflow.dev)** — Node graph engine (drag, zoom, edges, minimap)
- **[FastAPI](https://fastapi.tiangolo.com) + Uvicorn** — local scan worker
- **[Maigret](https://github.com/soxoj/maigret) 0.6.6** — username OSINT engine (`maigret[pdf]==0.6.6` pinned in `backend/requirements.txt`)
- **[uv](https://docs.astral.sh/uv/)** — relocatable project venv
- **Docker Compose** — optional container install: nginx serves the built app and proxies `/api/` to the maigret container
- **localStorage** — graph persistence

---

## Deployment

The app is designed to run locally. The supported deployment options are:

- **Docker Compose** (recommended) — `docker compose up -d --build`; see above.
- **Static build + local backend** — `npm run build`, serve `dist/` with any static web server, and proxy `/api/` to the FastAPI worker on `127.0.0.1:8000`.

There is no hosted service, account system, or cloud storage. Nothing leaves your machine except the outbound requests maigret makes while scanning a username.

---

## Development

```bash
npm run dev       # Start dev server (scans demand-start the backend)
npm run build     # Production build → dist/
npm run preview   # Preview the production build
npm run lint      # oxlint
```

All boards stay in your browser; the only external dependency is the local maigret backend for username scans.

---

## License

MIT
