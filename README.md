# VectorMapForge

Self-hosted OpenStreetMap vector tile server with ultra-low memory footprint. Runs on a $5/month VPS or your laptop.

```
┌─────────────────────────────────────────────────────────────────┐
│  Desktop (Build + Serve)                                         │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │   Dashboard  │───▶│  Planetiler  │───▶│  MBTiles     │       │
│  │  (Port 8051) │    │   (JVM)      │    │  (Docker Vol)│       │
│  └──────────────┘    └──────────────┘    └──────┬───────┘       │
│        │                                         │               │
│        │         ┌───────────────────────────────┘               │
│        │         ▼                                               │
│        │    ┌──────────────┐                                     │
│        └───▶│ Express      │◀── Browser/MapLibre/Tauri          │
│             │ (Port 8050)  │                                     │
│             │              │                                     │
│             │  ├─/data/* ──┼────▶ tileserver-rs (internal)      │
│             │  ├─/styles/*─┼────▶ static files                  │
│             │  └─/fonts/* ─┼────▶ static files                  │
│             └──────────────┘                                     │
└─────────────────────────────────────────────────────────────────┘
                               Export
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│  Server (Serve Only) — OCI Free Tier, 1GB RAM                    │
│  ┌──────────────┐    ┌──────────────┐                           │
│  │   Dashboard  │◀───│  MBTiles     │                           │
│  │ (Port 8051)  │    │  (Docker Vol)│                           │
│  └──────┬───────┘    └──────┬───────┘                           │
│         │                   │                                    │
│         └───────────┐       │                                    │
│                     ▼       ▼                                    │
│              ┌──────────────┐                                    │
│              │ Express      │◀── Browser/MapLibre               │
│              │ (Port 8050)  │                                    │
│              └──────────────┘                                    │
└─────────────────────────────────────────────────────────────────┘
```

## Why VectorMapForge?

| Feature | VectorMapForge | Traditional Stack |
|---------|---------------|-------------------|
| **Memory (Serve)** | ~55MB (Bun + Rust) | 400MB+ (Node.js + JVM always running) |
| **Memory (Build)** | 2-6GB temporary (JVM only during build) | 400MB+ constant |
| **Server CPU** | Low (Rust tileserver, no JVM overhead) | High (JVM constantly running) |
| **Build** | Desktop only | Anywhere |
| **Cost** | Free tier friendly (serve: 1GB RAM, build: 4GB+ RAM) | Needs paid VPS |

## Quick Start

### Desktop — Build Your Own Tiles

For users who want to download OSM data and generate tiles locally:

```bash
# 1. Clone and start
git clone https://github.com/ppugend/VectorMapForge.git
cd VectorMapForge
docker compose -f docker-compose.desktop.yml up -d

# 2. Open dashboard
curl http://localhost:8051  # Web UI will open

# 3. Build tiles (example: Monaco)
# - Search "monaco" in dashboard (Source: Geofabrik)
# - Click Download/Build (takes 1-2 min for small regions)
# - Verify at http://localhost:8050/data.json
```

**System Requirements:**
- Docker Desktop
- 4GB RAM (for building tiles)
- 10GB free disk space

**Ports:**
- `8050` — Unified endpoint (tiles + styles + fonts), public access
- `8051` — Dashboard (localhost only, build/import/export)

### Server — Serve Pre-built Tiles

For deploying on a VPS with minimal resources:

```bash
# 1. Copy required files to server
scp docker-compose.server.yml user@your-server:/opt/vectormapforge/
scp -r manager user@your-server:/opt/vectormapforge/

# Note: The 'manager' folder contains the Express server code and must be present

# 2. On server, start services
ssh user@your-server
cd /opt/vectormapforge
docker compose -f docker-compose.server.yml up -d

# 3. Import tiles from desktop (via SSH tunnel)
# On your local machine:
ssh -L 8051:localhost:8051 user@your-server
curl -X POST http://localhost:8051/api/import -F "file=@export.zip"

# 4. Public endpoint ready at:
# http://your-server:8050/data/{region}/{z}/{x}/{y}.pbf
# http://your-server:8050/styles/{id}/style.json
```

**Server Requirements:**
- Docker + Docker Compose
- 1GB RAM (512MB works for small regions)
- 5GB disk space

## Architecture

```
Unified Endpoint (Port 8050)
        │
        ▼
┌───────────────┐
│    Express    │ ← Bun runtime, ~25MB
│  (Bun.js)     │
└───────┬───────┘
        │
        ├─ /data/* ────▶ tileserver-rs (Rust, ~25MB) → MBTiles
        │
        ├─ /styles/* ──▶ /data/tileserver/styles/ (static)
        │
        └─ /fonts/* ───▶ /data/tileserver/fonts/ (static)

Admin Endpoint (Port 8051) - localhost only
        │
        ▼
┌───────────────┐
│    Express    │ ← API, management UI
│  (Bun.js)     │
└───────────────┘
```

**Components:**
| Service | Technology | Memory | Purpose |
|---------|-----------|--------|---------|
| Express | Bun + Express | ~25MB | Unified gateway, static files, API |
| tileserver-rs | Rust | ~25MB | High-performance tile serving (internal) |

### Smart Global Tiles

The `/data/global/{z}/{x}/{y}.pbf` endpoint automatically serves the best available tile:
- Queries individual region MBTiles using spatial bounds filtering
- Returns the largest tile when multiple regions overlap (e.g., Monaco + Liechtenstein at zoom 5)
- Falls back to global.mbtiles if no specific region has the tile
- O(1) lookup performance via cached bounds index

## Data Management

### Understanding Storage

VectorMapForge uses **Docker named volumes** (not bind mounts):

| Volume | Purpose | Persist? |
|--------|---------|----------|
| `osm_persistent_data` | MBTiles, PBF downloads, styles | ✅ Yes |
| `osm_build_temp` | Temporary build files | ❌ No (safe to delete) |

**Why volumes?**
- Planetiler (build) and tileserver (serve) share the same data space
- No host directory pollution (no `./data` in git status)
- Better performance than bind mounts

### Export / Import Workflow

Use the dashboard UI or automate with API:

```bash
# Export from desktop
curl -X POST http://localhost:8051/api/export \
  -d '{"regionIds":["monaco","liechtenstein"]}' \
  --output my-tiles.zip

# Import on server (via SSH tunnel)
curl -X POST http://localhost:8051/api/import \
  -F "file=@my-tiles.zip"
```

### Backup & Restore

```bash
# Backup all tile data
docker run --rm -v osm_persistent_data:/data \
  -v $(pwd):/backup alpine \
  tar czf /backup/vectormapforge-backup.tar.gz -C /data .

# Restore on new machine
docker run --rm -v osm_persistent_data:/data \
  -v $(pwd):/backup alpine \
  tar xzf /backup/vectormapforge-backup.tar.gz -C /data
```

## API Reference

### Public Endpoints (Port 8050)

All endpoints accessible publicly (or from Tauri app, browser, etc.):

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/data.json` | List all tile sources |
| GET | `/data/{id}.json` | TileJSON metadata |
| GET | `/data/{id}/{z}/{x}/{y}.pbf` | Vector tile (PBF/MVT) |
| GET | `/styles/{id}/style.json` | Map style JSON |
| GET | `/fonts/{fontstack}/{range}.pbf` | Font glyphs |
| GET | `/` | Web map viewer |

**Example:**
```bash
# Get tile
curl http://localhost:8050/data/monaco/14/8529/5986.pbf

# Get style
curl http://localhost:8050/styles/monaco/style.json

# View in browser (macOS: open, Linux: xdg-open, Windows: start)
# macOS:
open "http://localhost:8050/viewer.html?region=monaco&lat=43.7349&lng=7.4208&zoom=15"
# Linux:
xdg-open "http://localhost:8050/viewer.html?region=monaco&lat=43.7349&lng=7.4208&zoom=15"
```

### Admin API (Port 8051, localhost only)

Management endpoints (not exposed to public):

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Dashboard health |
| GET | `/api/sources` | Available OSM sources |
| GET | `/api/regions` | Regions list with status |
| GET | `/api/tiles` | Loaded MBTiles files |
| POST | `/api/update` | **Start build job** (desktop only) |
| GET | `/api/status` | Current build status |
| POST | `/api/cancel` | Cancel running build |
| POST | `/api/export` | Export MBTiles as ZIP |
| POST | `/api/import` | Import MBTiles from ZIP |
| POST | `/api/regenerate-styles` | Regenerate all style JSON files |
| POST | `/api/remove` | Remove region |

**Auto Features:**
- `global.mbtiles` is automatically rebuilt after build/import completes
- `data.json` is dynamically generated from actual MBTiles files (no restart needed)

## Configuration

### Environment Variables

Create `.env` file in project root:

```bash
# Ports
PUBLIC_PORT=8050        # Public endpoint (tiles + styles + fonts)
ADMIN_PORT=8051         # Admin endpoint (localhost only)

# Build settings (desktop only)
PLANETILER_JVM_MEMORY=2g  # JVM heap for tile generation
BUILD_DISABLED=false      # Set to 'true' on server

# Internal tileserver URL (for Express proxy)
TILESERVER_URL=http://tileserver:8080
```

### Docker Compose Files

| File | Use Case | Build | Import/Export |
|------|----------|-------|---------------|
| `docker-compose.desktop.yml` | Local development | ✅ Yes | ✅ Yes |
| `docker-compose.server.yml` | Production server | ❌ No | ✅ Yes |

**Port Mapping:**

| Compose File | 8050 (Public) | 8051 (Admin) |
|--------------|---------------|--------------|
| `desktop` | `0.0.0.0:8050` (all interfaces) | `127.0.0.1:8051` (localhost only) |
| `server` | `0.0.0.0:8050` (all interfaces) | `127.0.0.1:8051` (localhost only) |

## Troubleshooting

### Build fails with "out of memory"
Increase Docker memory limit (Desktop → Settings → Resources) or use smaller regions.

### "No such file or directory: /data/mbtiles/..."
The region hasn't been built yet. Check dashboard at `http://localhost:8051` and build the region first.

### Port already in use
```bash
# Change ports in .env
echo "PUBLIC_PORT=8052" >> .env
echo "ADMIN_PORT=8053" >> .env
docker compose -f docker-compose.desktop.yml up -d
```

### View tiles in map
```bash
# Built-in viewer
# macOS:
open http://localhost:8050
# Linux:
xdg-open http://localhost:8050

# Or use MapLibre with specific coordinates (Monaco example)
# macOS:
open "http://localhost:8050/viewer.html?region=monaco&lat=43.7349&lng=7.4208&zoom=15"
# Linux:
xdg-open "http://localhost:8050/viewer.html?region=monaco&lat=43.7349&lng=7.4208&zoom=15"
```

## Data Attribution

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL)

Tile schema based on [OpenMapTiles](https://openmaptiles.org/)

## License

MIT © [ppugend](https://github.com/ppugend)

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/B0B21CR05U)
