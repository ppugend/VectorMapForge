# VectorMapForge

Self-hosted OpenStreetMap vector tile server.
Build regional tile data on desktop, serve it anywhere.

```
Desktop  →  Download PBF  →  Build tiles (Planetiler)  →  Export ZIP
Server   →  Import ZIP    →  Serve vector tiles + map viewer
```

---

## Screenshots

| Server Dashboard | Forge (Build Manager) | Map Viewer |
|:---:|:---:|:---:|
| ![Server](images/screenshot_010.png) | ![Forge](images/screenshot_020.png) | ![Map](images/screenshot_030.png) |

---

## Features

- **Dual-port architecture** — public tile serving on 8050, admin dashboard on 8051 (localhost only)
- **Multi-source** — Geofabrik (512 regional extracts) and BBBike (238 city extracts)
- **Mirror selection** — per-source mirror dropdown + custom mirror URL
- **Build manager** — download PBF, run Planetiler, monitor progress via live log stream
- **Export / Import** — ZIP bundles for moving built tiles from desktop to server
- **Update checker** — MD5-based remote change detection
- **Seamless global tiles** — all loaded regions served as a single merged PBF tile stream; no region switching needed
- **MapLibre-ready** — auto-generated style JSON per region and globally; sprite, font, and tile URL rewriting included
- **Reverse proxy friendly** — `PUBLIC_URL` env var for correct TileJSON and style URLs

---

## Vector Tiles vs Raster Tiles

VectorMapForge serves **PBF vector tiles only** — it does not serve PNG raster tiles.

| | OSM Official | VectorMapForge |
|---|---|---|
| **Tile format** | PNG (pre-rendered raster image) | PBF — Protocol Buffers (raw geodata) |
| **Tile URL pattern** | `…/tile.openstreetmap.org/{z}/{x}/{y}.png` | `HOST:8050/data/global/{z}/{x}/{y}.pbf` |
| **Rendering** | Server-side — client receives a finished image | Client-side — MapLibre GL JS renders on device via WebGL |
| **Style control** | None — style is baked into the image | Full control via style JSON (colors, fonts, layer visibility) |
| **Data content** | Pixels | Roads, buildings, boundaries, labels as geometry |

Both use the **ZXY coordinate system** for tile requests. The map center is set with lat/lng — MapLibre computes the required ZXY tiles from the current viewport internally.

---

## Port Architecture

| Port | Access | Purpose |
|------|--------|---------|
| `8050` | Public | Tiles, map viewer, TileJSON, styles |
| `8051` | **Localhost only** | Forge build manager, import/export, remove tiles |

> **Security warning:** Never expose port `8051` externally. Anyone with access to it can delete or overwrite your tile data. Always expose only port `8050` via reverse proxy. Access `8051` via SSH tunnel when needed.

---

## Quick Start

### Desktop (build + serve)

```bash
docker compose -f docker-compose.desktop.yml up -d
```

Open Forge at **http://localhost:8051**, search for a region, and click **Download / Build**.

### Server (serve only)

```bash
docker compose -f docker-compose.server.yml up -d
```

Build is disabled on the server. Import tile ZIPs exported from the desktop.

---

## Access URLs

| Purpose | URL |
|---------|-----|
| **Server dashboard** | `http://HOST:8050/tiles.html` |
| **Forge (build manager)** | `http://localhost:8051/` — localhost only |
| **Map viewer** | `http://HOST:8050/viewer.html` |
| **Global TileJSON** | `http://HOST:8050/data/global.json` |
| **Global merged tile** | `http://HOST:8050/data/global/{z}/{x}/{y}.pbf` |
| **Global MapLibre style** | `http://HOST:8050/styles/global/style.json` |
| **Per-region TileJSON** | `http://HOST:8050/data/REGION_ID.json` |
| **Per-region tile** | `http://HOST:8050/data/REGION_ID/{z}/{x}/{y}.pbf` |
| **Per-region style** | `http://HOST:8050/styles/REGION_ID/style.json` |

### Viewer URL parameters

The viewer defaults to the `global` style (all regions merged). No `region` parameter is needed.
Roads are visible at zoom **14–16**.

**Method 1 — lat/lng**

```
/viewer.html?lat=LAT&lng=LNG&zoom=ZOOM
```

```
/viewer.html?lat=37.504364&lng=127.051338&zoom=15   # Seoul (Seolleung Station)
/viewer.html?lat=43.735800&lng=7.421300&zoom=15     # Monaco
/viewer.html?lat=13.753620&lng=100.490060&zoom=15   # Bangkok
```

**Method 2 — ZXY tile coordinate**

```
/viewer.html?z=Z&x=X&y=Y
```

Centers the map on the given tile. Useful when linking directly from tile inspection tools.

```
/viewer.html?z=15&x=27948&y=12696   # Seoul (Seolleung Station)
/viewer.html?z=15&x=17059&y=11948   # Monaco
/viewer.html?z=15&x=25530&y=15119   # Bangkok
```

---

## Desktop → Server Workflow

> **Note:** The server compose (`docker-compose.server.yml`) runs with `BUILD_DISABLED=true` — the build API is blocked (403). All tile building must be done on a desktop machine and transferred as a ZIP.

### 1. Build on desktop

```bash
docker compose -f docker-compose.desktop.yml up -d
```

1. Open **http://localhost:8051**
2. Search for a region (e.g. `south-korea`)
3. Click **Download / Build** and wait for completion

### 2. Export as ZIP

1. Check the region checkbox in Forge
2. Click **Export Selected (.zip)**
3. Save `vectormapforge-export-YYYY-MM-DD.zip`

ZIP contents:
```
vectormapforge-export-2026-03-20.zip
├── south-korea.mbtiles   # vector tile database
└── db.json               # metadata (MD5, update timestamps)
```

### 3. Transfer to server

```bash
scp vectormapforge-export-*.zip user@server:/home/user/
```

### 4. Import on server

**Option A — Dashboard (recommended)**

```bash
ssh -L 8051:localhost:8051 user@server
# Then open http://localhost:8051 in your local browser
```

Use **Import ZIP** → select file → **Upload & Import**.

**Option B — curl**

```bash
curl -X POST http://localhost:8051/api/import \
  -F "file=@vectormapforge-export-2026-03-20.zip"
```

### 5. Verify

```bash
curl http://localhost:8050/data/south-korea.json
```

---

## Docker Compose Files

| File | Use case | `BUILD_DISABLED` | `docker.sock` | `osm_temp` volume |
|------|----------|-----------------|---------------|-------------------|
| `docker-compose.desktop.yml` | Local desktop — build + serve | unset | ✅ required | ✅ required |
| `docker-compose.server.yml` | Remote server — serve only | `true` | ❌ | ❌ |

---

## Commands

```bash
# Start
docker compose -f docker-compose.desktop.yml up -d

# Stop — keep data volumes (recommended)
docker compose -f docker-compose.desktop.yml down

# Restart (pick up code changes)
docker compose -f docker-compose.desktop.yml restart

# Logs
docker logs -f vectormapforge
```

> **Do not use `down -v`** — this deletes all Docker volumes including your built tile data and build cache files (lake centerlines, water polygons, Natural Earth). These auxiliary files are shared across all builds and are slow to re-download. Only use `down -v` if you intend to start completely from scratch.

---

## Build Cache

Planetiler downloads auxiliary data files on first build and reuses them on subsequent builds:

| File | Purpose |
|------|---------|
| `lake_centerline.shp.zip` | Lake centerline geometry |
| `water-polygons-split-3857.zip` | Ocean and water polygons |
| `natural_earth_vector.sqlite.zip` | Natural Earth base data |

These files rarely change. If you need to force a refresh (e.g. after a major Planetiler upgrade), use the **Clear Build Cache** button in Forge — it deletes the cached files so they are re-downloaded on the next build.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATA_DIR` | `/osm_data` | Tiles, styles, fonts, build cache |
| `TEMP_DIR` | `/osm_temp` | Planetiler build scratch space |
| `BUILD_DISABLED` | `false` | Set `true` to disable build API (403) |
| `PUBLIC_URL` | *(none)* | External base URL for reverse proxy |
| `PLANETILER_JVM_MEMORY` | *(none)* | JVM heap for Planetiler (e.g. `6g`). If unset, no `-Xmx` flag is passed and the JVM uses its own default. |
| `PUBLIC_PORT` | `3000` | Internal public port |
| `ADMIN_PORT` | `3001` | Internal admin port |

---

## Reverse Proxy (nginx)

```nginx
server {
    listen 443 ssl;
    server_name tiles.example.com;

    location / {
        proxy_pass http://localhost:8050;
        proxy_set_header Host $host;
    }
}
```

Set `PUBLIC_URL` so TileJSON and style URLs resolve correctly:

```yaml
# docker-compose.server.yml
environment:
  - PUBLIC_URL=https://tiles.example.com
```

Do **not** proxy port `8051` — it is admin-only and should remain localhost only.

---

## MapLibre Integration

```javascript
// Global style — all loaded regions merged seamlessly
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.example.com/styles/global/style.json',
});

// Per-region style
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.example.com/styles/south-korea/style.json',
});
```

With Leaflet + leaflet-maplibre-gl:

```javascript
L.maplibreGL({
  style: 'https://tiles.example.com/styles/global/style.json',
}).addTo(map);
```

---

## Support This Project

If you found this project helpful, consider supporting its maintenance and future development with a small donation.
You can buy me a coffee via the Ko-fi link below — thank you! ☕✨

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/B0B21CR05U)

---

## License

MIT © [ppugend](https://github.com/ppugend)

---

## Data Attribution

Map tiles built with this tool contain data from **OpenStreetMap**, licensed under the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/).

When displaying maps publicly, you must show attribution:

```
© OpenStreetMap contributors
```

The built-in map viewer already includes this attribution. If you embed tiles in your own application, add the notice to your map UI.
