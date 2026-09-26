# VectorMapForge

Self-hosted OpenStreetMap vector tile server with ultra-low memory footprint. Runs on a $5/month VPS or your laptop.

## Screenshots

| Server Dashboard | Forge (Build Manager) | Map Viewer |
|:---:|:---:|:---:|
| ![Server](images/screenshot_010.png) | ![Forge](images/screenshot_020.png) | ![Map](images/screenshot_030.png) |

```
┌─────────────────────────────────────────────────────────────────┐
│  Desktop Mode (Build + Serve)                                    │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │   Dashboard  │───▶│  Tilemaker   │───▶│  MBTiles     │       │
│  │  (Port 8051) │    │   (C++)      │    │  (Docker Vol)│       │
│  └──────────────┘    └──────────────┘    └──────┬───────┘       │
│        │                                         │               │
│        │         ┌───────────────────────────────┘               │
│        │         ▼                                               │
│        │    ┌──────────────┐                                     │
│        └───▶│   Express    │◀── Browser/MapLibre/Tauri          │
│             │ (Port 8050)  │    ├─/data/*→tileserver-rs(Rust)   │
│             └──────────────┘    ├─/styles/*, /fonts/* (static)  │
└─────────────────────────────────────────────────────────────────┘
                               Export
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│  Server Mode (Serve Only) — OCI Free Tier, 1GB RAM               │
│  ┌──────────────┐    ┌──────────────┐                           │
│  │   Dashboard  │◀───│  MBTiles     │                           │
│  │ (Port 8051)  │    │  (Docker Vol)│                           │
│  └──────┬───────┘    └──────┬───────┘                           │
│         │                   │                                    │
│         └───────────┐       │                                    │
│                     ▼       ▼                                    │
│              ┌──────────────┐                                    │
│              │   Express    │◀── Browser/MapLibre               │
│              │ (Port 8050)  │                                    │
│              └──────────────┘                                    │
└─────────────────────────────────────────────────────────────────┘
```

**Components:**
| Service | Technology | Memory | Purpose |
|---------|-----------|--------|---------|
| Express | Bun + Express | ~25MB | Unified gateway, static files, API |
| tileserver-rs | Rust | ~25MB | High-performance tile serving (internal) |
| Tilemaker | C++ | 2-4GB (build only) | Vector tile generation (desktop only) |

**Commands:**
```bash
make desktop  # Start desktop mode (build + serve)
make server   # Start server mode (serve only)
make down     # Stop all services
make logs     # View logs
make status   # Check status
```

## Why VectorMapForge?

| Feature | VectorMapForge | Traditional Stack |
|---------|---------------|-------------------|
| **Memory (Serve)** | ~55MB (Bun + Rust) | 400MB+ (Node.js + JVM always running) |
| **Memory (Build)** | 2-4GB temporary (C++, no JVM overhead) | 400MB+ constant |
| **Server CPU** | Low (Rust tileserver, no JVM overhead) | High (JVM constantly running) |
| **Build** | Desktop only¹ | Anywhere |
| **Cost** | Free tier friendly (serve: 1GB RAM, build: 4GB+ RAM) | Needs paid VPS |

¹ **Why Desktop-only build?** To prevent accidental execution on low-resource VPS servers. Building tiles requires 2-4GB RAM temporarily, which can crash or freeze a $5/month VPS. Always build tiles on your desktop/laptop, then export and import to the server.

## Quick Start

### Desktop — Build Your Own Tiles

```bash
# 1. Clone and start
git clone https://github.com/ppugend/VectorMapForge.git
cd VectorMapForge
make desktop              # macOS/Linux
# mingw32-make desktop   # Windows (Git Bash/MinGW)

# 2. Open dashboard
open http://localhost:8051  # macOS
# xdg-open http://localhost:8051  # Linux
# start http://localhost:8051  # Windows

# 3. Build tiles (Search "monaco" → Download/Build)
```

**Requirements:** Docker Desktop, 4GB RAM, 10GB disk

### Server — Serve Pre-built Tiles

⚠️ **Do not build on server!** Build on desktop first, then import.

```bash
# On server:
make server              # macOS/Linux
# mingw32-make server   # Windows (Git Bash/MinGW)
```

**Export from desktop → Import to server:**

1. **Desktop:** Build tiles in dashboard → Click "Export" → Download ZIP
2. **Transfer:** `scp export.zip user@your-server:/tmp/`
3. **Connect:** `ssh -L 8051:localhost:8051 user@your-server`
4. **Open:** http://localhost:8051 → Click "Import" → Select ZIP

**Requirements:** Docker, 1GB RAM, 5GB disk

<details>
<summary>Alternative methods (click to expand)</summary>

**Command line (without dashboard):**
```bash
# Export from desktop
curl -X POST http://localhost:8051/api/export \
  -d '{"regionIds":["monaco"]}' --output export.zip

# Import to server (via SSH tunnel)
ssh -L 8051:localhost:8051 user@your-server
curl -X POST http://localhost:8051/api/import -F "file=@export.zip"
```

</details>

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
- Tilemaker (build) and tileserver (serve) share the same data space
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
TILEMAKER_IMAGE=tilemaker:local-v3.1.0  # Tilemaker Docker image
BUILD_DISABLED=false                    # Set to 'true' on server

# Internal tileserver URL (for Express proxy)
TILESERVER_URL=http://tileserver:8080
```

### Tilemaker Setup

VectorMapForge uses [Tilemaker](https://github.com/systemed/tilemaker) (C++) for vector tile generation instead of Planetiler (Java) for lower memory footprint and faster builds.

**Automatic Setup (Recommended):**
```bash
# The Makefile/scripts automatically:
# 1. Clone https://github.com/ppugend/tilemaker.git
# 2. Checkout v3.1.0 tag
# 3. Build Docker image: tilemaker:local-v3.1.0
# 4. Start all services

make desktop  # One command does it all
```

**Manual Setup:**
```bash
# If you prefer manual control:
git clone https://github.com/ppugend/tilemaker.git
cd tilemaker
git checkout v3.1.0
docker build -t tilemaker:local-v3.1.0 .
cd ..
docker compose -f docker-compose.desktop.yml up -d
```

**Updating Tilemaker:**
```bash
# To update to a newer version:
cd tilemaker
git fetch --tags
git checkout v3.2.0  # or newer version
cd ..
docker compose -f docker-compose.desktop.yml build tilemaker
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

## Tested Environment

This configuration has been tested on:

- **macOS** (x64) - Primary development and testing platform

Other platforms (Linux, Windows, ARM64) should work but have not been explicitly tested. Please report any issues you encounter on different environments.

## Data Attribution

Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL)

Tile schema based on [OpenMapTiles](https://openmaptiles.org/)

## Third Party Licenses

This project uses open source components:

- **tileserver-rs**: MIT License
- **OpenMapTiles schema**: BSD-3-Clause

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for full details.

## License

MIT © [ppugend](https://github.com/ppugend)

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/B0B21CR05U)
