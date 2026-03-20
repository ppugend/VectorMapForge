const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const AdmZip = require('adm-zip');
const multer = require('multer');
const { Database } = require('bun:sqlite');
const { gunzipSync, gzipSync } = require('zlib');

const PUBLIC_PORT    = parseInt(process.env.PUBLIC_PORT || '3000');
const ADMIN_PORT     = parseInt(process.env.ADMIN_PORT  || '3001');
const BUILD_DISABLED = process.env.BUILD_DISABLED === 'true';
const PUBLIC_URL     = process.env.PUBLIC_URL || null;

const DATA_DIR        = process.env.DATA_DIR || '/osm_data';
const TEMP_DIR        = process.env.TEMP_DIR || '/osm_temp';
const DB_PATH         = path.join(DATA_DIR, 'db.json');
const TILESERVER_ROOT = path.join(DATA_DIR, 'tileserver');

const upload = multer({ dest: '/tmp/uploads/' });

// ── Database ──────────────────────────────────────────────────────────────────
let db = { regions: {} };
if (fs.existsSync(DB_PATH)) {
  try { db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch (e) {}
}
function saveDb() { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }

// ── Fetch helper ──────────────────────────────────────────────────────────────
function fetchText(url) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.get : http.get;
    get(url, r => {
      if (r.statusCode >= 300 && r.statusCode < 400) return resolve(fetchText(r.headers.location));
      if (r.statusCode >= 400) { r.resume(); return reject(new Error(`HTTP ${r.statusCode}: ${url}`)); }
      let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d.trim()));
    }).on('error', reject);
  });
}

// ── Sources ───────────────────────────────────────────────────────────────────
// Each source: { id, name, desc, cacheFile, fetch(), getMd5(region) }
const regionsBySource = {};

async function fetchGeofabrikIndex() {
  const html = await fetchText('https://download.geofabrik.de/index-v1.json');
  const geojson = JSON.parse(html);
  return geojson.features
    .filter(f => f.properties?.urls?.pbf)
    .map(f => {
      const coords = [];
      function collect(arr) {
        if (!Array.isArray(arr)) return;
        if (typeof arr[0] === 'number') { coords.push(arr); return; }
        arr.forEach(collect);
      }
      collect(f.geometry?.coordinates);
      let center = [0, 0];
      if (coords.length) {
        const lons = coords.map(c => c[0]), lats = coords.map(c => c[1]);
        center = [
          +((Math.min(...lons) + Math.max(...lons)) / 2).toFixed(4),
          +((Math.min(...lats) + Math.max(...lats)) / 2).toFixed(4),
        ];
      }
      return {
        id:     f.properties.id.replace(/\//g, '--'),
        name:   f.properties.name,
        url:    f.properties.urls.pbf,
        parent: f.properties.parent || null,
        center,
      };
    });
}

async function fetchBBBikeIndex() {
  const html = await fetchText('https://download.bbbike.org/osm/bbbike/');
  const skip = new Set(['Metadata', 'Screenshots', 'CHECKSUM']);
  const regions = [];
  const regex = /href="([A-Z][^"\/]{1,60})\/"/g;
  let m;
  while ((m = regex.exec(html)) !== null) {
    const hrefName = m[1];
    const name = decodeURIComponent(hrefName);
    if (skip.has(name)) continue;
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    regions.push({
      id,
      name,
      url: `https://download.bbbike.org/osm/bbbike/${hrefName}/${hrefName}.osm.pbf`,
      parent: null,
      center: null,
    });
  }
  return regions;
}

const SOURCES = [
  {
    id: 'geofabrik',
    name: 'Geofabrik',
    desc: 'Country & regional extracts (~512 regions)',
    canonicalBase: 'https://download.geofabrik.de',
    mirrors: [
      { id: 'official',  name: 'Official (download.geofabrik.de)' },
      { id: 'custom',    name: 'Custom URL...' },
    ],
    cacheFile: () => path.join(DATA_DIR, 'geofabrik-index.json'),
    fetch: fetchGeofabrikIndex,
    mirrorUrl(region, mirrorBase) {
      return region.url.replace(this.canonicalBase, mirrorBase || this.canonicalBase);
    },
    async getMd5(canonicalUrl) {
      const text = await fetchText(canonicalUrl + '.md5');
      return text.split(/\s+/)[0];
    },
  },
  {
    id: 'bbbike',
    name: 'BBBike',
    desc: 'City-level extracts (~200 cities)',
    canonicalBase: 'https://download.bbbike.org/osm/bbbike',
    mirrors: [
      { id: 'official', name: 'Official (download.bbbike.org)' },
      { id: 'gwdg',     name: 'GWDG Mirror (Germany)',         base: 'https://ftp5.gwdg.de/pub/misc/openstreetmap/download.bbbike.org/osm/bbbike' },
      { id: 'utwente',  name: 'Univ. of Twente (Netherlands)', base: 'https://ftp.snt.utwente.nl/pub/misc/openstreetmap/download.bbbike.org/osm/bbbike' },
      { id: 'custom',   name: 'Custom URL...' },
    ],
    cacheFile: () => path.join(DATA_DIR, 'bbbike-index.json'),
    fetch: fetchBBBikeIndex,
    mirrorUrl(region, mirrorBase) {
      return region.url.replace(this.canonicalBase, mirrorBase || this.canonicalBase);
    },
    async getMd5(canonicalUrl) {
      const dir = canonicalUrl.substring(0, canonicalUrl.lastIndexOf('/'));
      const text = await fetchText(`${dir}/CHECKSUM.txt`);
      const line = text.split('\n').find(l => /\.osm\.pbf\s*$/.test(l.trim()));
      return line ? line.trim().split(/\s+/)[0] : null;
    },
  },
];

function getSource(id) { return SOURCES.find(s => s.id === id); }
function getRegionById(id, sourceId) {
  const list = regionsBySource[sourceId] || [];
  // Try exact match first, then try slash↔dash conversions for backward compatibility
  return list.find(r => r.id === id)
      || list.find(r => r.id === id.replace(/\//g, '--'))
      || list.find(r => r.id === id.replace(/--/g, '/'))
      || null;
}

async function loadSourceIndex(source) {
  const cacheFile = source.cacheFile();
  if (fs.existsSync(cacheFile)) {
    try {
      regionsBySource[source.id] = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      console.log(`Loaded ${regionsBySource[source.id].length} ${source.id} regions from cache`);
      return;
    } catch (e) {}
  }
  regionsBySource[source.id] = await source.fetch();
  fs.writeFileSync(cacheFile, JSON.stringify(regionsBySource[source.id], null, 2));
  console.log(`Fetched ${regionsBySource[source.id].length} ${source.id} regions`);
}

// ── MBTiles cache ─────────────────────────────────────────────────────────────
const mbtilesCache = new Map();

function getMbtilesDb(regionId) {
  if (mbtilesCache.has(regionId)) return mbtilesCache.get(regionId);
  const p = path.join(DATA_DIR, 'mbtiles', `${regionId}.mbtiles`);
  if (!fs.existsSync(p)) return null;
  const mdb = new Database(p, { readonly: true });
  mbtilesCache.set(regionId, mdb);
  return mdb;
}

function closeMbtilesDb(regionId) {
  if (!mbtilesCache.has(regionId)) return;
  try { mbtilesCache.get(regionId).close(); } catch (e) {}
  mbtilesCache.delete(regionId);
}

// ── Style generation ──────────────────────────────────────────────────────────
function generateRegionStyle(regionId) {
  const baseStylePath = path.join(TILESERVER_ROOT, 'styles/osm-bright/style.json');
  if (!fs.existsSync(baseStylePath)) return;
  try {
    const style = JSON.parse(fs.readFileSync(baseStylePath, 'utf8'));
    if (style.sources?.openmaptiles) {
      style.sources[regionId] = { ...style.sources.openmaptiles, url: `mbtiles://${regionId}` };
      delete style.sources.openmaptiles;
    }
    if (style.layers) {
      style.layers = style.layers.map(l =>
        l.source === 'openmaptiles' ? { ...l, source: regionId } : l
      );
    }
    const dir = path.join(TILESERVER_ROOT, `styles/${regionId}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'style.json'), JSON.stringify(style, null, 2));
  } catch (e) { console.error(`Style generation failed for ${regionId}:`, e.message); }
}

// ── Bootstrap & provisioning ──────────────────────────────────────────────────
function bootstrap() {
  [
    path.join(DATA_DIR, 'pbf'),
    path.join(DATA_DIR, 'mbtiles'),
    path.join(DATA_DIR, 'sources'),
    TILESERVER_ROOT,
    path.join(TILESERVER_ROOT, 'styles'),
    path.join(TILESERVER_ROOT, 'fonts'),
    path.join(TEMP_DIR, 'work'),
  ].forEach(d => fs.mkdirSync(d, { recursive: true }));
}

function sh(cmd) {
  return new Promise((resolve, reject) =>
    spawn('sh', ['-c', cmd], { stdio: 'inherit' })
      .on('close', code => code === 0 ? resolve() : reject(new Error(`sh failed (${code}): ${cmd}`)))
  );
}

async function provisionStyles() {
  const brightDir = path.join(TILESERVER_ROOT, 'styles/osm-bright');
  if (fs.existsSync(path.join(brightDir, 'style.json'))) return;
  console.log('Provisioning osm-bright style...');
  fs.mkdirSync(brightDir, { recursive: true });
  await sh(`curl -sL https://github.com/openmaptiles/osm-bright-gl-style/archive/refs/heads/master.tar.gz | tar -xz -C "${brightDir}" --strip-components=1`);
  const styleJson = JSON.parse(fs.readFileSync(path.join(brightDir, 'style.json'), 'utf8'));
  styleJson.glyphs = '{fontstack}/{range}.pbf';
  if (styleJson.sources?.openmaptiles) styleJson.sources.openmaptiles.url = 'mbtiles://openmaptiles';
  fs.writeFileSync(path.join(brightDir, 'style.json'), JSON.stringify(styleJson, null, 2));
  console.log('osm-bright style provisioned.');
}

async function provisionFonts() {
  const fontFile = path.join(TILESERVER_ROOT, 'fonts/Noto Sans Regular/0-255.pbf');
  if (fs.existsSync(fontFile) && fs.statSync(fontFile).size >= 1000) return;
  console.log('Provisioning Noto Sans fonts...');
  await sh(`curl -sL https://github.com/openmaptiles/fonts/releases/download/v2.0/noto-sans.zip -o /tmp/noto-sans.zip && unzip -o /tmp/noto-sans.zip -d "${TILESERVER_ROOT}/fonts/" && rm /tmp/noto-sans.zip`);
  console.log('Fonts provisioned.');
}

// ── Build helpers ─────────────────────────────────────────────────────────────
let currentTask = null;

function runCommand(command, args, onLog) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);
    if (currentTask) currentTask.process = proc;
    proc.stdout.on('data', d => onLog?.(d.toString()));
    proc.stderr.on('data', d => onLog?.(d.toString()));
    proc.on('close', code => {
      if (currentTask) currentTask.process = null;
      if (code === 0) resolve();
      else if (currentTask?.aborted) reject(new Error('Task cancelled by user'));
      else reject(new Error(`Failed with code ${code}`));
    });
  });
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = url.startsWith('https') ? https.get : http.get;
    const request = get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        return resolve(downloadFile(res.headers.location, dest, onProgress));
      }
      const total = parseInt(res.headers['content-length'], 10);
      let downloaded = 0, lastPercent = -1;
      res.on('data', chunk => {
        downloaded += chunk.length;
        if (total) {
          const pct = Math.floor((downloaded / total) * 100);
          if (pct !== lastPercent) { lastPercent = pct; onProgress?.(pct, downloaded, total); }
        }
      });
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    });
    request.on('error', e => { fs.unlink(dest, () => {}); reject(e); });
    if (currentTask) currentTask.request = request;
  });
}

// ── URL helper ────────────────────────────────────────────────────────────────
function getPublicOrigin(req) {
  return PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
}

// ── Public app ────────────────────────────────────────────────────────────────
const publicApp = express();
publicApp.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

publicApp.get('/favicon.ico', (req, res) => res.redirect('/favicon.svg'));
publicApp.get('/favicon.svg',  (req, res) => res.sendFile(path.join(__dirname, 'public/favicon.svg')));
publicApp.get('/viewer.html',  (req, res) => res.sendFile(path.join(__dirname, 'public/viewer.html')));
publicApp.use('/sprites', express.static(path.join(__dirname, 'public/sprites')));

// Global merged tile endpoint — queries all loaded MBTiles in sequence, returns first match.
// Enables seamless cross-region maps without per-region style switching.
publicApp.get('/data/global.json', (req, res) => {
  const origin = getPublicOrigin(req);
  res.json({
    tilejson: '3.0.0',
    id: 'global',
    name: 'Global (all regions merged)',
    tiles: [`${origin}/data/global/{z}/{x}/{y}.pbf`],
    minzoom: 0,
    maxzoom: 14,
    format: 'pbf',
    bounds: [-180, -85, 180, 85],
    center: [0, 0, 2],
    attribution: '© OpenStreetMap contributors',
  });
});

publicApp.get('/data/global/:z/:x/:y.pbf', (req, res) => {
  const { z, x, y } = req.params;
  let zi = parseInt(z), xi = parseInt(x), yi = parseInt(y);
  if (zi > 14) { const s = zi - 14; xi >>= s; yi >>= s; zi = 14; }
  const tmsY = (1 << zi) - 1 - yi;
  const mbtilesDir = path.join(DATA_DIR, 'mbtiles');
  if (!fs.existsSync(mbtilesDir)) return res.status(204).end();
  const regionIds = fs.readdirSync(mbtilesDir)
    .filter(f => f.endsWith('.mbtiles'))
    .map(f => f.replace('.mbtiles', ''));

  // Collect raw gzipped tile data from every mbtiles that has this tile
  const tileBuffers = [];
  for (const id of regionIds) {
    const mdb = getMbtilesDb(id);
    if (!mdb) continue;
    try {
      const row = mdb.query('SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?').get(zi, xi, tmsY);
      if (row) tileBuffers.push(Buffer.from(row.tile_data));
    } catch (e) { /* skip broken mbtiles */ }
  }

  if (tileBuffers.length === 0) return res.status(204).end();

  res.set('Content-Type', 'application/x-protobuf');
  res.set('Content-Encoding', 'gzip');
  res.set('Cache-Control', 'public, max-age=86400');

  if (tileBuffers.length === 1) return res.send(tileBuffers[0]);

  // Merge: protobuf vector tile = repeated Layer messages.
  // Concatenating the raw decoded bytes of multiple tiles produces a valid merged tile
  // because protobuf repeated fields are wire-compatible when concatenated.
  try {
    const rawBuffers = tileBuffers.map(buf => gunzipSync(buf));
    return res.send(gzipSync(Buffer.concat(rawBuffers)));
  } catch (e) {
    // Fallback: return first tile if merge fails
    return res.send(tileBuffers[0]);
  }
});

publicApp.get('/data/:id.json', (req, res) => {
  const mdb = getMbtilesDb(req.params.id);
  if (!mdb) return res.status(404).json({ error: 'Region not found' });
  try {
    const meta = {};
    mdb.query('SELECT name, value FROM metadata').all().forEach(r => { meta[r.name] = r.value; });
    const origin = getPublicOrigin(req);
    res.json({
      tilejson:    '3.0.0',
      id:          req.params.id,
      name:        meta.name || req.params.id,
      description: meta.description || '',
      minzoom:     parseInt(meta.minzoom) || 0,
      maxzoom:     parseInt(meta.maxzoom) || 14,
      format:      meta.format || 'pbf',
      tiles:       [`${origin}/data/${req.params.id}/{z}/{x}/{y}.pbf`],
      bounds:      meta.bounds ? meta.bounds.split(',').map(Number) : [-180, -85, 180, 85],
      center:      meta.center ? meta.center.split(',').map(Number) : [0, 0, 2],
      attribution: meta.attribution || '',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

publicApp.get('/data/:id/:z/:x/:y.pbf', (req, res) => {
  const { id, z, x, y } = req.params;
  const mdb = getMbtilesDb(id);
  if (!mdb) return res.status(404).send('Region not found');
  try {
    let zi = parseInt(z), xi = parseInt(x), yi = parseInt(y);
    if (zi > 14) { const s = zi - 14; xi >>= s; yi >>= s; zi = 14; }
    const tmsY = (1 << zi) - 1 - yi;
    const row = mdb.query('SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?').get(zi, xi, tmsY);
    if (!row) return res.status(204).end();
    res.set('Content-Type', 'application/x-protobuf');
    res.set('Content-Encoding', 'gzip');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(row.tile_data));
  } catch (e) { res.status(500).send(e.message); }
});

publicApp.get('/styles/:id/style.json', (req, res) => {
  const regionId = req.params.id.replace(/-pretty$/, '');
  const stylePath = path.join(TILESERVER_ROOT, 'styles', regionId, 'style.json');
  if (!fs.existsSync(stylePath)) return res.status(404).json({ error: `Style not found: ${regionId}` });
  try {
    const style = JSON.parse(fs.readFileSync(stylePath, 'utf8'));
    const origin = getPublicOrigin(req);
    for (const src of Object.values(style.sources || {})) {
      if (typeof src.url === 'string' && src.url.startsWith('mbtiles://')) {
        src.url = `${origin}/data/${src.url.slice('mbtiles://'.length)}.json`;
      }
    }
    if (style.sprite) style.sprite = `${origin}/sprites/sprite`;
    style.glyphs = `${origin}/fonts/{fontstack}/{range}.pbf`;
    res.json(style);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

publicApp.get('/fonts/:fontstack/:range.pbf', (req, res) => {
  const fontPath = path.join(TILESERVER_ROOT, 'fonts', req.params.fontstack, `${req.params.range}.pbf`);
  if (!fs.existsSync(fontPath)) return res.status(404).send('Font not found');
  res.set('Content-Type', 'application/x-protobuf');
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(fontPath);
});

// ── Admin app ─────────────────────────────────────────────────────────────────
const adminApp = express();
adminApp.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });
adminApp.use(express.json());
adminApp.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
adminApp.use(publicApp);
adminApp.use(express.static(path.join(__dirname, 'public')));
adminApp.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

adminApp.get('/api/config', (req, res) => {
  res.json({ buildDisabled: BUILD_DISABLED });
});

adminApp.get('/api/sources', (req, res) => {
  res.json(SOURCES.map(s => ({
    id:      s.id,
    name:    s.name,
    desc:    s.desc,
    count:   (regionsBySource[s.id] || []).length,
    mirrors: s.mirrors,
  })));
});

adminApp.get('/api/tiles', (req, res) => {
  const mbtilesDir = path.join(DATA_DIR, 'mbtiles');
  const files = fs.existsSync(mbtilesDir)
    ? fs.readdirSync(mbtilesDir).filter(f => f.endsWith('.mbtiles'))
    : [];
  const tiles = files.map(f => {
    const id = f.replace('.mbtiles', '');
    const record = db.regions[id] || {};
    const sourceId = record.sourceId || 'geofabrik';
    const region = getRegionById(id, sourceId);
    return {
      id,
      name:       region?.name || id,
      size:       fs.statSync(path.join(mbtilesDir, f)).size,
      lastUpdate: record.lastUpdate || null,
    };
  });
  tiles.sort((a, b) => a.name.localeCompare(b.name));
  res.json(tiles);
});

adminApp.get('/api/regions', (req, res) => {
  const sourceId = req.query.source || 'geofabrik';
  const regions = (regionsBySource[sourceId] || []).map(r => {
    const mbtilesPath = path.join(DATA_DIR, 'mbtiles', `${r.id}.mbtiles`);
    const hasMbtiles  = fs.existsSync(mbtilesPath);
    return {
      ...r,
      status:      db.regions[r.id] || {},
      hasMbtiles,
      mbtilesSize: hasMbtiles ? fs.statSync(mbtilesPath).size : 0,
      pbfBytes:    db.regions[r.id]?.pbfBytes || 0,
    };
  });
  regions.sort((a, b) => (b.hasMbtiles ? 1 : 0) - (a.hasMbtiles ? 1 : 0));
  res.json(regions);
});

adminApp.get('/api/status', (req, res) => {
  if (!currentTask) return res.json({ task: null });
  const { process: _p, request: _r, ...taskData } = currentTask;
  taskData.logs = (taskData.logs || '').split('\n').slice(-200).join('\n');
  res.json({ task: taskData });
});

adminApp.post('/api/cancel', (req, res) => {
  if (!currentTask) return res.status(400).json({ error: 'No task running' });
  currentTask.aborted = true;
  currentTask.process?.kill('SIGKILL');
  currentTask.request?.destroy();
  currentTask.status = 'Cancelled';
  currentTask.logs += '\n--- TASK CANCELLED BY USER ---\n';
  res.json({ ok: true });
  setTimeout(() => { currentTask = null; }, 5000);
});

adminApp.post('/api/remove', (req, res) => {
  const { regionId } = req.body;
  if (!regionId) return res.status(400).json({ error: 'regionId required' });
  try {
    closeMbtilesDb(regionId);
    const p = path.join(DATA_DIR, 'mbtiles', `${regionId}.mbtiles`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    delete db.regions[regionId];
    saveDb();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

adminApp.delete('/api/build-cache', (req, res) => {
  const files = [
    'lake_centerline.shp.zip',
    'water-polygons-split-3857.zip',
    'natural_earth_vector.sqlite.zip',
  ];
  const results = [];
  for (const f of files) {
    const p = path.join(DATA_DIR, 'sources', f);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      results.push({ file: f, deleted: true });
    } else {
      results.push({ file: f, deleted: false, reason: 'not found' });
    }
  }
  res.json({ results });
});

adminApp.post('/api/check-updates', async (req, res) => {
  const results = [];
  for (const id of Object.keys(db.regions).filter(id => db.regions[id].localMd5)) {
    const record   = db.regions[id];
    const sourceId = record.sourceId || 'geofabrik';
    const source   = getSource(sourceId);
    const region   = getRegionById(id, sourceId);
    if (!region || !source) { results.push({ id, name: id, error: true }); continue; }
    try {
      const remoteMd5 = await source.getMd5(region.url);
      db.regions[id].remoteMd5 = remoteMd5;
      db.regions[id].lastCheck = new Date().toISOString();
      saveDb();
      results.push({ id, name: region.name, hasUpdate: record.localMd5 !== remoteMd5 });
    } catch (e) { results.push({ id, name: region.name, error: e.message }); }
  }
  res.json({ results });
});

adminApp.post('/api/refresh-source', async (req, res) => {
  const sourceId = req.body.source || 'geofabrik';
  const source = getSource(sourceId);
  if (!source) return res.status(400).json({ error: `Unknown source: ${sourceId}` });
  try {
    regionsBySource[source.id] = await source.fetch();
    fs.writeFileSync(source.cacheFile(), JSON.stringify(regionsBySource[source.id], null, 2));
    res.json({ count: regionsBySource[source.id].length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

adminApp.post('/api/export', (req, res) => {
  const { regionIds } = req.body;
  if (!regionIds?.length) return res.status(400).json({ error: 'regionIds required' });
  const zip = new AdmZip();
  const exportDb = { regions: {} };
  regionIds.forEach(id => {
    const p = path.join(DATA_DIR, 'mbtiles', `${id}.mbtiles`);
    if (fs.existsSync(p)) {
      zip.addLocalFile(p);
      if (db.regions[id]) exportDb.regions[id] = db.regions[id];
    }
  });
  zip.addFile('db.json', Buffer.from(JSON.stringify(exportDb, null, 2)));
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="vectormapforge-export-${ts}.zip"`);
  res.send(zip.toBuffer());
});

adminApp.post('/api/import', upload.single('file'), (req, res) => {
  try {
    const zip = new AdmZip(req.file.path);
    const dbEntry = zip.getEntry('db.json');
    if (!dbEntry) throw new Error('db.json not found in ZIP');
    const importDb = JSON.parse(dbEntry.getData().toString());
    zip.getEntries().forEach(e => {
      if (!e.entryName.endsWith('.mbtiles')) return;
      const regionId = e.entryName.replace('.mbtiles', '');
      closeMbtilesDb(regionId);
      fs.writeFileSync(path.join(DATA_DIR, 'mbtiles', e.entryName), e.getData());
    });
    for (const id in importDb.regions) {
      db.regions[id] = importDb.regions[id];
      generateRegionStyle(id);
    }
    generateRegionStyle('global'); // regenerate merged style with all regions
    saveDb();
    res.json({ ok: true, imported: Object.keys(importDb.regions) });
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { if (req.file) fs.unlink(req.file.path, () => {}); }
});

adminApp.post('/api/update', async (req, res) => {
  if (BUILD_DISABLED) return res.status(403).json({ error: 'Build is disabled on this instance.' });
  const { regionId, source: sourceId = 'geofabrik', mirror: mirrorId, customMirrorBase } = req.body;
  const source = getSource(sourceId);
  const region = source ? getRegionById(regionId, sourceId) : null;
  if (!source)   return res.status(400).json({ error: `Unknown source: ${sourceId}` });
  if (!region)   return res.status(400).json({ error: 'Region not found' });
  if (currentTask) return res.status(400).json({ error: 'Another task is running' });

  // Resolve mirror base URL
  const mirrorDef = source.mirrors.find(m => m.id === mirrorId);
  const mirrorBase = mirrorId === 'custom' ? customMirrorBase
    : (mirrorDef?.base || source.canonicalBase);
  const downloadUrl = source.mirrorUrl(region, mirrorBase);

  res.json({ ok: true });

  const pbfPath        = path.join(DATA_DIR, 'pbf', `${region.id}.osm.pbf`);
  const mbtilesPath    = path.join(DATA_DIR, 'mbtiles', `${region.id}.mbtiles`);
  const tmpMbtilesPath = path.join(DATA_DIR, 'mbtiles', `${region.id}_temp.mbtiles`);
  const jvmMemory = process.env.PLANETILER_JVM_MEMORY || '';

  currentTask = { title: `Build · ${region.name}`, region: region.name, regionId: region.id, status: 'Starting...', logs: '', aborted: false };
  const log = m => { if (currentTask) currentTask.logs += m + '\n'; };
  let pbfBytes = 0;

  try {
    currentTask.status = 'Downloading PBF...';
    log(`Downloading ${downloadUrl}...`);
    await downloadFile(downloadUrl, pbfPath, (pct, cur, tot) => {
      if (tot) pbfBytes = tot;
      currentTask.status = `Downloading: ${pct}% (${(cur/1048576).toFixed(1)} / ${(tot/1048576).toFixed(1)} MB)`;
    });

    if (currentTask.aborted) throw new Error('Aborted');

    // MD5 always checked against canonical source
    const remoteMd5 = await source.getMd5(region.url).catch(() => null);

    if (!fs.existsSync(pbfPath)) {
      throw new Error(`PBF file not found at ${pbfPath} — download may have failed silently`);
    }

    currentTask.status = 'Building vectors...';
    const jvmEnv = jvmMemory ? [`-e`, `JAVA_TOOL_OPTIONS=-Xmx${jvmMemory}`] : [];
    await runCommand('docker', [
      'run', '--rm',
      ...jvmEnv,
      '-v', `osm_persistent_data:${DATA_DIR}`,
      '-v', `osm_build_temp:${TEMP_DIR}`,
      'ghcr.io/onthegomap/planetiler:latest',
      `--osm-path=${pbfPath}`,
      `--output=${tmpMbtilesPath}`,
      `--tmpdir=${TEMP_DIR}/work`,
      `--lake-centerlines-path=${DATA_DIR}/sources/lake_centerline.shp.zip`,
      `--water-polygons-path=${DATA_DIR}/sources/water-polygons-split-3857.zip`,
      `--natural-earth-path=${DATA_DIR}/sources/natural_earth_vector.sqlite.zip`,
      `--wikidata-cache=${DATA_DIR}/sources/wikidata_names.json`,
      '--download', '--nodemap-type=array', '--force',
    ], log);

    if (currentTask.aborted) throw new Error('Aborted');

    closeMbtilesDb(region.id);
    fs.renameSync(tmpMbtilesPath, mbtilesPath);
    fs.unlink(pbfPath, () => {});
    db.regions[region.id] = {
      sourceId,
      sourceUrl:  region.url,
      localMd5:   remoteMd5,
      remoteMd5,
      pbfBytes:   pbfBytes || db.regions[region.id]?.pbfBytes || 0,
      lastUpdate: new Date().toISOString(),
    };
    saveDb();
    generateRegionStyle(region.id);
    generateRegionStyle('global'); // regenerate merged style with all regions

    currentTask.status = 'Completed';
    log('--- DONE ---');
    setTimeout(() => { if (currentTask?.status === 'Completed') currentTask = null; }, 10000);
  } catch (e) {
    if (currentTask) {
      currentTask.status = currentTask.aborted ? 'Cancelled' : 'Error';
      log(`ERROR: ${e.message}`);
    }
    fs.unlink(pbfPath, () => {});
    fs.unlink(tmpMbtilesPath, () => {});
    setTimeout(() => { currentTask = null; }, 20000);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
bootstrap();
async function start() {
  await Promise.all([
    provisionStyles().catch(e => console.error('Style provisioning failed:', e.message)),
    provisionFonts().catch(e => console.error('Font provisioning failed:', e.message)),
    ...SOURCES.map(s => loadSourceIndex(s).catch(e => console.error(`${s.id} index load failed:`, e.message))),
  ]);
  generateRegionStyle('global'); // build merged global style from all available MBTiles
  http.createServer(publicApp).listen(PUBLIC_PORT, () =>
    console.log(`Public server : http://0.0.0.0:${PUBLIC_PORT}`)
  );
  http.createServer(adminApp).listen(ADMIN_PORT, () =>
    console.log(`Admin  server : http://127.0.0.1:${ADMIN_PORT}`)
  );
}
start();
