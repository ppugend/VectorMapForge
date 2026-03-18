const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const AdmZip = require('adm-zip');
const multer = require('multer');
const { Database } = require('bun:sqlite');

const PUBLIC_PORT = parseInt(process.env.PUBLIC_PORT || '3000');
const ADMIN_PORT  = parseInt(process.env.ADMIN_PORT  || '3001');
const BUILD_DISABLED = process.env.BUILD_DISABLED === 'true';
const PUBLIC_URL = process.env.PUBLIC_URL || null; // e.g. https://tiles.example.com

const DATA_DIR        = process.env.DATA_DIR  || '/osm_data';
const TEMP_DIR        = process.env.TEMP_DIR  || '/osm_temp';
const DB_PATH         = path.join(DATA_DIR, 'db.json');
const TILESERVER_ROOT = path.join(DATA_DIR, 'tileserver');
const GEOFABRIK_INDEX_PATH = path.join(DATA_DIR, 'geofabrik-index.json');

const upload = multer({ dest: '/tmp/uploads/' });

let db = { regions: {} };
if (fs.existsSync(DB_PATH)) {
  try { db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch (e) {}
}
function saveDb() { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }

// ── Geofabrik index ──────────────────────────────────────────────────────────
let geofabrikRegions = [];
function getRegionById(id) { return geofabrikRegions.find(r => r.id === id) || null; }

function getBboxCenter(feature) {
  const coords = [];
  function collect(arr) {
    if (!Array.isArray(arr)) return;
    if (typeof arr[0] === 'number') { coords.push(arr); return; }
    arr.forEach(collect);
  }
  collect(feature.geometry && feature.geometry.coordinates);
  if (!coords.length) return [0, 0];
  const lons = coords.map(c => c[0]), lats = coords.map(c => c[1]);
  return [
    +((Math.min(...lons) + Math.max(...lons)) / 2).toFixed(4),
    +((Math.min(...lats) + Math.max(...lats)) / 2).toFixed(4),
  ];
}

function fetchAndCacheGeofabrikIndex() {
  return new Promise((resolve, reject) => {
    https.get('https://download.geofabrik.de/index-v1.json', (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const geojson = JSON.parse(data);
          geofabrikRegions = geojson.features
            .filter(f => f.properties && f.properties.urls && f.properties.urls.pbf)
            .map(f => ({
              id: f.properties.id, name: f.properties.name,
              url: f.properties.urls.pbf,
              parent: f.properties.parent || null,
              center: getBboxCenter(f),
            }));
          fs.writeFileSync(GEOFABRIK_INDEX_PATH, JSON.stringify(geofabrikRegions, null, 2));
          console.log(`Fetched and cached ${geofabrikRegions.length} Geofabrik regions`);
          resolve();
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function loadGeofabrikIndex() {
  if (fs.existsSync(GEOFABRIK_INDEX_PATH)) {
    try {
      geofabrikRegions = JSON.parse(fs.readFileSync(GEOFABRIK_INDEX_PATH, 'utf8'));
      console.log(`Loaded ${geofabrikRegions.length} Geofabrik regions from cache`);
      return Promise.resolve();
    } catch(e) {}
  }
  return fetchAndCacheGeofabrikIndex();
}

// ── MBTiles cache ────────────────────────────────────────────────────────────
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
  if (mbtilesCache.has(regionId)) {
    try { mbtilesCache.get(regionId).close(); } catch(e) {}
    mbtilesCache.delete(regionId);
  }
}

// ── Style generation ─────────────────────────────────────────────────────────
function generateRegionStyle(regionId) {
  const baseStylePath = path.join(TILESERVER_ROOT, 'styles/osm-bright/style.json');
  const regionStyleDir = path.join(TILESERVER_ROOT, `styles/${regionId}`);
  if (!fs.existsSync(baseStylePath)) return;
  try {
    const style = JSON.parse(fs.readFileSync(baseStylePath, 'utf8'));
    if (style.sources && style.sources.openmaptiles) {
      style.sources[regionId] = { ...style.sources.openmaptiles, url: `mbtiles://${regionId}` };
      delete style.sources.openmaptiles;
    }
    if (style.layers) {
      style.layers = style.layers.map(l =>
        l.source === 'openmaptiles' ? { ...l, source: regionId } : l
      );
    }
    fs.mkdirSync(regionStyleDir, { recursive: true });
    fs.writeFileSync(path.join(regionStyleDir, 'style.json'), JSON.stringify(style, null, 2));
  } catch (e) { console.error(`Failed to generate style for ${regionId}:`, e.message); }
}

// ── Bootstrap & provisioning ─────────────────────────────────────────────────
function bootstrap() {
  [
    path.join(DATA_DIR, 'pbf'), path.join(DATA_DIR, 'mbtiles'),
    path.join(DATA_DIR, 'sources'), TILESERVER_ROOT,
    path.join(TILESERVER_ROOT, 'styles'), path.join(TILESERVER_ROOT, 'fonts'),
    path.join(TEMP_DIR, 'work'),
  ].forEach(f => { if (!fs.existsSync(f)) fs.mkdirSync(f, { recursive: true }); });
}

function sh(cmd) {
  return new Promise((resolve, reject) => {
    spawn('sh', ['-c', cmd], { stdio: 'inherit' }).on('close', code =>
      code === 0 ? resolve() : reject(new Error(`sh failed (${code}): ${cmd}`))
    );
  });
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

// ── Build task ───────────────────────────────────────────────────────────────
let currentTask = null;

function runCommand(command, args, onLog) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);
    if (currentTask) currentTask.process = proc;
    proc.stdout.on('data', d => onLog && onLog(d.toString()));
    proc.stderr.on('data', d => onLog && onLog(d.toString()));
    proc.on('close', code => {
      if (currentTask) currentTask.process = null;
      if (code === 0) resolve();
      else if (currentTask && currentTask.aborted) reject(new Error('Task cancelled by user'));
      else reject(new Error(`Failed with code ${code}`));
    });
  });
}

function downloadFileWithProgress(url, dest, onProgress, onLog) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = url.startsWith('https') ? https.get : http.get;
    const request = get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return resolve(downloadFileWithProgress(res.headers.location, dest, onProgress, onLog));
      }
      const totalSize = parseInt(res.headers['content-length'], 10);
      let downloadedSize = 0, lastPercent = -1;
      res.on('data', (chunk) => {
        downloadedSize += chunk.length;
        if (totalSize) {
          const percent = Math.floor((downloadedSize / totalSize) * 100);
          if (percent !== lastPercent) { lastPercent = percent; onProgress && onProgress(percent, downloadedSize, totalSize); }
        }
      });
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    });
    request.on('error', e => { fs.unlink(dest, () => {}); reject(e); });
    if (currentTask) currentTask.request = request;
  });
}

// ── URL helper ───────────────────────────────────────────────────────────────
// Returns origin for tile/style URLs.
// Uses request's own host header — works correctly when accessed via the mapped external port.
// Set PUBLIC_URL env var when behind a reverse proxy or to force a specific base URL.
function getPublicOrigin(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  return `${req.protocol}://${req.get('host')}`;
}

// ── Public app (tiles, styles, fonts, sprites, viewer) ───────────────────────
const publicApp = express();
publicApp.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

publicApp.get('/', (req, res) => res.redirect('/tiles.html'));
publicApp.get('/favicon.ico', (req, res) => res.redirect('/favicon.svg'));
publicApp.get('/favicon.svg', (req, res) => res.sendFile(path.join(__dirname, 'public/favicon.svg')));
publicApp.get('/tiles.html', (req, res) => res.sendFile(path.join(__dirname, 'public/tiles.html')));
publicApp.get('/viewer.html', (req, res) => res.sendFile(path.join(__dirname, 'public/viewer.html')));
publicApp.use('/sprites', express.static(path.join(__dirname, 'public/sprites')));

// Served tiles list (public — no admin needed)
publicApp.get('/api/tiles', (req, res) => {
  const mbtilesDir = path.join(DATA_DIR, 'mbtiles');
  const files = fs.existsSync(mbtilesDir) ? fs.readdirSync(mbtilesDir).filter(f => f.endsWith('.mbtiles')) : [];
  const tiles = files.map(f => {
    const id = f.replace('.mbtiles', '');
    const p = path.join(mbtilesDir, f);
    const size = fs.statSync(p).size;
    const region = geofabrikRegions.find(r => r.id === id);
    const status = db.regions[id] || {};
    return { id, name: region ? region.name : id, size, lastUpdate: status.lastUpdate || null };
  });
  tiles.sort((a, b) => a.name.localeCompare(b.name));
  res.json(tiles);
});

// TileJSON
publicApp.get('/data/:id.json', (req, res) => {
  const mdb = getMbtilesDb(req.params.id);
  if (!mdb) return res.status(404).json({ error: 'Region not found' });
  try {
    const meta = {};
    mdb.query('SELECT name, value FROM metadata').all().forEach(r => { meta[r.name] = r.value; });
    const origin = getPublicOrigin(req);
    res.json({
      tilejson: '3.0.0', id: req.params.id,
      name: meta.name || req.params.id,
      description: meta.description || '',
      minzoom: parseInt(meta.minzoom) || 0,
      maxzoom: parseInt(meta.maxzoom) || 14,
      format: meta.format || 'pbf',
      tiles: [`${origin}/data/${req.params.id}/{z}/{x}/{y}.pbf`],
      bounds: meta.bounds ? meta.bounds.split(',').map(Number) : [-180, -85, 180, 85],
      center: meta.center ? meta.center.split(',').map(Number) : [0, 0, 2],
      attribution: meta.attribution || '',
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Vector tile
publicApp.get('/data/:id/:z/:x/:y.pbf', (req, res) => {
  const { id, z, x, y } = req.params;
  const mdb = getMbtilesDb(id);
  if (!mdb) return res.status(404).send('Region not found');
  try {
    const zi = parseInt(z), xi = parseInt(x), yi = parseInt(y);
    const tmsY = Math.pow(2, zi) - 1 - yi;
    const row = mdb.query('SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?').get(zi, xi, tmsY);
    if (!row) return res.status(404).send(`Tile not found: z=${zi}, x=${xi}, y=${yi}`);
    res.set('Content-Type', 'application/x-protobuf');
    res.set('Content-Encoding', 'gzip');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(row.tile_data));
  } catch(e) { res.status(500).send(e.message); }
});

// Style JSON (rewrites mbtiles:// URLs dynamically)
publicApp.get('/styles/:id/style.json', (req, res) => {
  const regionId = req.params.id.replace(/-pretty$/, '');
  const stylePath = path.join(TILESERVER_ROOT, 'styles', regionId, 'style.json');
  if (!fs.existsSync(stylePath)) return res.status(404).json({ error: `Style not found: ${req.params.id}` });
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
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Fonts
publicApp.get('/fonts/:fontstack/:range.pbf', (req, res) => {
  const fontPath = path.join(TILESERVER_ROOT, 'fonts', req.params.fontstack, `${req.params.range}.pbf`);
  if (!fs.existsSync(fontPath)) return res.status(404).send('Font not found');
  res.set('Content-Type', 'application/x-protobuf');
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(fontPath);
});

// ── Admin app (public routes + dashboard + API) ───────────────────────────────
const adminApp = express();
adminApp.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });
adminApp.use(express.json());
adminApp.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
adminApp.use(publicApp); // inherit all public routes
adminApp.use('/debug.html', (req, res) => res.status(404).send('Not Found'));
adminApp.use(express.static(path.join(__dirname, 'public')));

adminApp.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

adminApp.get('/api/config', (req, res) => {
  res.json({ buildDisabled: BUILD_DISABLED });
});

adminApp.get('/api/regions', (req, res) => {
  const regionsWithStatus = geofabrikRegions.map(r => {
    const status = db.regions[r.id] || {};
    const mbtilesPath = path.join(DATA_DIR, 'mbtiles', `${r.id}.mbtiles`);
    const hasMbtiles = fs.existsSync(mbtilesPath);
    const mbtilesSize = hasMbtiles ? fs.statSync(mbtilesPath).size : 0;
    return { ...r, status, hasMbtiles, mbtilesSize };
  });
  regionsWithStatus.sort((a, b) => (b.hasMbtiles ? 1 : 0) - (a.hasMbtiles ? 1 : 0));
  res.json(regionsWithStatus);
});

adminApp.get('/api/status', (req, res) => {
  if (!currentTask) return res.json({ task: null });
  const { process: _proc, request: _req, ...taskData } = currentTask;
  const lines = (taskData.logs || '').split('\n');
  taskData.logs = lines.slice(-200).join('\n');
  res.json({ task: taskData });
});

adminApp.post('/api/cancel', (req, res) => {
  if (!currentTask) return res.status(400).json({ error: 'No task running' });
  currentTask.aborted = true;
  if (currentTask.process) currentTask.process.kill('SIGKILL');
  if (currentTask.request) currentTask.request.destroy();
  currentTask.status = 'Cancelled';
  currentTask.logs += '\n--- TASK CANCELLED BY USER ---\n';
  res.json({ message: 'Cancellation requested' });
  setTimeout(() => { currentTask = null; }, 5000);
});

adminApp.post('/api/remove', (req, res) => {
  const { regionId } = req.body;
  if (!regionId) return res.status(400).json({ error: 'No regionId' });
  try {
    closeMbtilesDb(regionId);
    const mbtilesPath = path.join(DATA_DIR, 'mbtiles', `${regionId}.mbtiles`);
    if (fs.existsSync(mbtilesPath)) fs.unlinkSync(mbtilesPath);
    delete db.regions[regionId];
    saveDb();
    res.json({ message: `Removed ${regionId}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

adminApp.post('/api/check-updates', async (req, res) => {
  const results = [];
  for (const regionId of Object.keys(db.regions).filter(id => db.regions[id].localMd5)) {
    const region = getRegionById(regionId);
    if (!region) { results.push({ id: regionId, name: regionId, error: true }); continue; }
    try {
      const get = region.url.startsWith('https') ? https.get : http.get;
      const fetchText = (url) => new Promise((resolve, reject) => {
        get(url, r => {
          if (r.statusCode >= 300 && r.statusCode < 400) return resolve(fetchText(r.headers.location));
          let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d.trim()));
        }).on('error', reject);
      });
      const remoteMd5 = (await fetchText(region.url + '.md5')).split(/\s+/)[0];
      db.regions[region.id].remoteMd5 = remoteMd5;
      db.regions[region.id].lastCheck = new Date().toISOString();
      saveDb();
      const local = db.regions[region.id];
      results.push({ id: region.id, name: region.name, hasUpdate: !!(local.localMd5 && local.localMd5 !== remoteMd5), isNew: false });
    } catch (e) { results.push({ id: region.id, name: region.name, error: true }); }
  }
  res.json({ results });
});

adminApp.post('/api/refresh-geofabrik', async (req, res) => {
  try {
    await fetchAndCacheGeofabrikIndex();
    res.json({ count: geofabrikRegions.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

adminApp.post('/api/export', (req, res) => {
  const { regionIds } = req.body;
  const zip = new AdmZip();
  const exportDb = { regions: {} };
  regionIds.forEach(id => {
    const p = path.join(DATA_DIR, 'mbtiles', `${id}.mbtiles`);
    if (fs.existsSync(p)) { zip.addLocalFile(p); if (db.regions[id]) exportDb.regions[id] = db.regions[id]; }
  });
  zip.addFile('db.json', Buffer.from(JSON.stringify(exportDb, null, 2)));
  const ts = new Date().toISOString().slice(0,19).replace(/[:T]/g, '-');
  const filename = `osm-export-${ts}.zip`;
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(zip.toBuffer());
});

adminApp.post('/api/import', upload.single('file'), (req, res) => {
  try {
    const zip = new AdmZip(req.file.path);
    const dbEntry = zip.getEntry('db.json');
    if (!dbEntry) throw new Error('No db.json');
    const importDb = JSON.parse(dbEntry.getData().toString());
    zip.getEntries().forEach(e => {
      if (e.entryName.endsWith('.mbtiles')) {
        const regionId = e.entryName.replace('.mbtiles', '');
        closeMbtilesDb(regionId);
        fs.writeFileSync(path.join(DATA_DIR, 'mbtiles', e.entryName), e.getData());
      }
    });
    for (const id in importDb.regions) { db.regions[id] = importDb.regions[id]; generateRegionStyle(id); }
    saveDb();
    res.json({ message: 'Imported' });
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { if (req.file) fs.unlinkSync(req.file.path); }
});

adminApp.post('/api/update', async (req, res) => {
  if (BUILD_DISABLED) return res.status(403).json({ error: 'Build disabled. Build on desktop and import.' });
  const { regionId } = req.body;
  const region = getRegionById(regionId);
  if (!region || currentTask) return res.status(400).json({ error: !region ? 'Region not found' : 'Busy' });

  res.json({ message: 'Update started' });
  currentTask = { title: `빌드 · ${region.name}`, region: region.name, status: 'Starting...', logs: '', aborted: false };
  const log = m => { if (currentTask) currentTask.logs += m + '\n'; };
  const pbfPath = path.join(DATA_DIR, 'pbf', `${region.id}.osm.pbf`);
  const mbtilesPath = path.join(DATA_DIR, 'mbtiles', `${region.id}.mbtiles`);
  const tempMbtilesPath = path.join(DATA_DIR, 'mbtiles', `${region.id}_temp.mbtiles`);

  try {
    currentTask.status = 'Downloading PBF...';
    log(`Downloading ${region.url}...`);
    await downloadFileWithProgress(region.url, pbfPath, (p, cur, tot) => {
      currentTask.status = `Downloading: ${p}% (${(cur/1024/1024).toFixed(1)}MB / ${(tot/1024/1024).toFixed(1)}MB)`;
    }, log);

    if (currentTask.aborted) throw new Error('Aborted');

    const fetchText = (url) => new Promise((resolve) => {
      const g = url.startsWith('https') ? https.get : http.get;
      g(url, r => {
        if (r.statusCode >= 300 && r.statusCode < 400) return resolve(fetchText(r.headers.location));
        let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d.trim()));
      });
    });
    const remoteMd5 = (await fetchText(region.url + '.md5')).split(/\s+/)[0];

    currentTask.status = 'Building Vectors...';
    const jvmMemory = process.env.PLANETILER_JVM_MEMORY || '6g';
    await runCommand('docker', [
      'run', '--rm',
      '-e', `JAVA_TOOL_OPTIONS=-Xmx${jvmMemory}`,
      '-v', `osm_persistent_data:${DATA_DIR}`,
      '-v', `osm_build_temp:${TEMP_DIR}`,
      'ghcr.io/onthegomap/planetiler:latest',
      `--osm-path=${pbfPath}`, `--output=${tempMbtilesPath}`, `--tmpdir=${TEMP_DIR}/work`,
      `--lake-centerlines-path=${DATA_DIR}/sources/lake_centerline.shp.zip`,
      `--water-polygons-path=${DATA_DIR}/sources/water-polygons-split-3857.zip`,
      `--natural-earth-path=${DATA_DIR}/sources/natural_earth_vector.sqlite.zip`,
      `--wikidata-cache=${DATA_DIR}/sources/wikidata_names.json`,
      '--download', '--nodemap-type=array', '--force',
    ], log);

    if (currentTask.aborted) throw new Error('Aborted');

    closeMbtilesDb(region.id);
    fs.renameSync(tempMbtilesPath, mbtilesPath);
    fs.unlink(pbfPath, () => {});
    db.regions[region.id] = { sourceUrl: region.url, localMd5: remoteMd5, remoteMd5, lastUpdate: new Date().toISOString() };
    saveDb();
    generateRegionStyle(region.id);

    currentTask.status = 'Completed';
    log('--- DONE ---');
    setTimeout(() => { if (currentTask && currentTask.status === 'Completed') currentTask = null; }, 10000);
  } catch (e) {
    if (currentTask) { currentTask.status = currentTask.aborted ? 'Cancelled' : 'Error'; log(`ERROR: ${e.message}`); }
    fs.unlink(pbfPath, () => {});
    fs.unlink(tempMbtilesPath, () => {});
    setTimeout(() => { currentTask = null; }, 20000);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
bootstrap();
async function start() {
  await Promise.all([
    provisionStyles().catch(e => console.error('Style provisioning failed:', e.message)),
    provisionFonts().catch(e => console.error('Font provisioning failed:', e.message)),
    loadGeofabrikIndex().catch(e => console.error('Geofabrik index failed:', e.message)),
  ]);
  http.createServer(publicApp).listen(PUBLIC_PORT, () => console.log(`Public  server: http://0.0.0.0:${PUBLIC_PORT}`));
  http.createServer(adminApp).listen(ADMIN_PORT,  () => console.log(`Admin   server: http://127.0.0.1:${ADMIN_PORT}`));
}
start();
