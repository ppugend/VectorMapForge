const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const AdmZip = require('adm-zip');
const multer = require('multer');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use('/debug.html', (req, res) => res.status(404).send('Not Found'));
app.get('/favicon.ico', (req, res) => res.redirect('/favicon.svg'));
app.use(express.static('public'));

app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

const DATA_DIR = process.env.DATA_DIR || '/osm_data';
const TEMP_DIR = process.env.TEMP_DIR || '/osm_temp';
const DB_PATH = path.join(DATA_DIR, 'db.json');
const TILESERVER_ROOT = path.join(DATA_DIR, 'tileserver');
const TILESERVER_CONFIG_PATH = path.join(TILESERVER_ROOT, 'config.toml');

const upload = multer({ dest: '/tmp/uploads/' });

const REGIONS = [
  { id: 'monaco',      url: 'https://download.geofabrik.de/europe/monaco-latest.osm.pbf',      name: 'Monaco',      center: [7.42, 43.73] },
  { id: 'andorra',     url: 'https://download.geofabrik.de/europe/andorra-latest.osm.pbf',     name: 'Andorra',     center: [1.52, 42.51] },
  { id: 'south-korea', url: 'https://download.geofabrik.de/asia/south-korea-latest.osm.pbf',   name: 'South Korea', center: [127.0, 37.5] },
  { id: 'japan',       url: 'https://download.geofabrik.de/asia/japan-latest.osm.pbf',          name: 'Japan',       center: [139.6, 35.7] },
  { id: 'taiwan',      url: 'https://download.geofabrik.de/asia/taiwan-latest.osm.pbf',         name: 'Taiwan',      center: [121.0, 23.7] },
  { id: 'china',       url: 'https://download.geofabrik.de/asia/china-latest.osm.pbf',          name: 'China',       center: [116.4, 39.9] },
  { id: 'vietnam',     url: 'https://download.geofabrik.de/asia/vietnam-latest.osm.pbf',        name: 'Vietnam',     center: [106.7, 10.8] },
  { id: 'thailand',    url: 'https://download.geofabrik.de/asia/thailand-latest.osm.pbf',       name: 'Thailand',    center: [100.5, 13.8] }
];

let db = { regions: {} };
if (fs.existsSync(DB_PATH)) {
  try { db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch (e) {}
}

function generateTomlConfig(regionsDb) {
  let toml = `fonts = "/data/tileserver/fonts"\nfiles = "/data/tileserver"\n\n[server]\nhost = "0.0.0.0"\nport = 8080\npublic_url = "http://localhost:8081"\ncors_origins = ["*"]\n`;
  for (const regionId in regionsDb) {
    const r = regionsDb[regionId];
    if (r.localMd5) {
      const region = REGIONS.find(reg => reg.id === regionId);
      const [lon, lat] = region ? region.center : [0, 0];
      // Each region gets its OWN source id to avoid collision
      toml += `\n[[sources]]\nid = "${regionId}"\ntype = "mbtiles"\npath = "/data/mbtiles/${regionId}.mbtiles"\n`;
      toml += `\n[[styles]]\nid = "${regionId}-pretty"\npath = "/data/tileserver/styles/${regionId}/style.json"\n[styles.tilejson]\ncenter = [${lon}, ${lat}, 10]\nzoom = 10\n`;
    }
  }
  return toml;
}

// Generate a per-region style.json by copying osm-bright and replacing source references
function generateRegionStyle(regionId) {
  const baseStylePath = path.join(TILESERVER_ROOT, 'styles/osm-bright/style.json');
  const regionStyleDir = path.join(TILESERVER_ROOT, `styles/${regionId}`);
  const regionStylePath = path.join(regionStyleDir, 'style.json');
  if (!fs.existsSync(baseStylePath)) return;
  try {
    const style = JSON.parse(fs.readFileSync(baseStylePath, 'utf8'));
    // Rename "openmaptiles" source to this region's id
    if (style.sources && style.sources.openmaptiles) {
      style.sources[regionId] = { ...style.sources.openmaptiles, url: `http://localhost:8081/data/${regionId}.json` };
      delete style.sources.openmaptiles;
    }
    // Update all layer source references
    if (style.layers) {
      style.layers = style.layers.map(l =>
        l.source === 'openmaptiles' ? { ...l, source: regionId } : l
      );
    }
    // Use manager-served sprites so tileserver-rs built-in viewer also works
    if (style.sprite) style.sprite = 'http://localhost:8082/sprites/sprite';
    fs.mkdirSync(regionStyleDir, { recursive: true });
    fs.writeFileSync(regionStylePath, JSON.stringify(style, null, 2));
  } catch (e) {
    console.error(`Failed to generate style for ${regionId}:`, e.message);
  }
}

function bootstrap() {
  const folders = [
    path.join(DATA_DIR, 'pbf'), path.join(DATA_DIR, 'mbtiles'),
    path.join(DATA_DIR, 'sources'), TILESERVER_ROOT,
    path.join(TILESERVER_ROOT, 'styles'), path.join(TILESERVER_ROOT, 'fonts'),
    path.join(TEMP_DIR, 'work')
  ];
  folders.forEach(f => { if (!fs.existsSync(f)) fs.mkdirSync(f, { recursive: true }); });
  if (!fs.existsSync(TILESERVER_CONFIG_PATH)) {
    fs.writeFileSync(TILESERVER_CONFIG_PATH, generateTomlConfig(db.regions));
  }
}
bootstrap();

function saveDb() { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }

let currentTask = null; // { region, status, logs, process, aborted }

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
      let downloadedSize = 0;
      let lastPercent = -1;

      res.on('data', (chunk) => {
        downloadedSize += chunk.length;
        if (totalSize) {
          const percent = Math.floor((downloadedSize / totalSize) * 100);
          if (percent !== lastPercent) {
            lastPercent = percent;
            onProgress && onProgress(percent, downloadedSize, totalSize);
          }
        }
      });

      res.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    });

    request.on('error', e => {
      fs.unlink(dest, () => {});
      reject(e);
    });

    if (currentTask) currentTask.request = request;
  });
}

// API: Cancel current task
app.post('/api/cancel', (req, res) => {
  if (!currentTask) return res.status(400).json({ error: 'No task running' });
  
  currentTask.aborted = true;
  if (currentTask.process) {
    // Kill the docker process and its children
    currentTask.process.kill('SIGKILL');
  }
  if (currentTask.request) {
    currentTask.request.destroy();
  }
  
  const regionName = currentTask.region;
  currentTask.status = 'Cancelled';
  currentTask.logs += '\n--- TASK CANCELLED BY USER ---\n';
  
  res.json({ message: 'Cancellation requested' });
  setTimeout(() => { currentTask = null; }, 5000);
});

// API: Remove region
app.post('/api/remove', async (req, res) => {
  const { regionId } = req.body;
  if (!regionId) return res.status(400).json({ error: 'No regionId' });
  
  try {
    const mbtilesPath = path.join(DATA_DIR, 'mbtiles', `${regionId}.mbtiles`);
    const pbfPath = path.join(DATA_DIR, 'pbf', `${regionId}.osm.pbf`);
    
    if (fs.existsSync(mbtilesPath)) fs.unlinkSync(mbtilesPath);
    if (fs.existsSync(pbfPath)) fs.unlinkSync(pbfPath);
    
    delete db.regions[regionId];
    saveDb();
    
    fs.writeFileSync(TILESERVER_CONFIG_PATH, generateTomlConfig(db.regions));
    await runCommand('docker', ['kill', '-s', 'SIGHUP', process.env.TILESERVER_CONTAINER]).catch(() => {});
    
    res.json({ message: `Removed ${regionId}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/regions', (req, res) => {
  const regionsWithStatus = REGIONS.map(r => ({ ...r, status: db.regions[r.id] || {} }));
  regionsWithStatus.sort((a, b) => (b.status.localMd5 ? 1 : 0) - (a.status.localMd5 ? 1 : 0));
  res.json(regionsWithStatus);
});

app.get('/api/status', (req, res) => {
  if (!currentTask) return res.json({ task: null });
  const { process: _proc, request: _req, ...taskData } = currentTask;
  // Send only the last 200 lines to avoid huge responses
  const lines = (taskData.logs || '').split('\n');
  taskData.logs = lines.slice(-200).join('\n');
  res.json({ task: taskData });
});

app.post('/api/check-updates', async (req, res) => {
  const results = [];
  for (const region of REGIONS) {
    try {
      const get = region.url.startsWith('https') ? https.get : http.get;
      const fetchText = (url) => new Promise((resolve, reject) => {
        get(url, r => {
          if (r.statusCode >= 300 && r.statusCode < 400) return resolve(fetchText(r.headers.location));
          let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d.trim()));
        }).on('error', reject);
      });
      const remoteMd5Raw = await fetchText(region.url + '.md5');
      const remoteMd5 = remoteMd5Raw.split(/\s+/)[0];
      if (!db.regions[region.id]) db.regions[region.id] = {};
      db.regions[region.id].remoteMd5 = remoteMd5;
      db.regions[region.id].lastCheck = new Date().toISOString();
      saveDb();
      const local = db.regions[region.id];
      results.push({ id: region.id, name: region.name, hasUpdate: !!(local.localMd5 && local.localMd5 !== remoteMd5), isNew: !local.localMd5 });
    } catch (e) {
      results.push({ id: region.id, name: region.name, error: true });
    }
  }
  res.json({ results });
});

app.post('/api/update', async (req, res) => {
  const { regionId } = req.body;
  const region = REGIONS.find(r => r.id === regionId);
  if (!region || currentTask) return res.status(400).json({ error: 'Busy' });

  res.json({ message: 'Update started' });
  currentTask = { title: `빌드 · ${region.name}`, region: region.name, status: 'Starting...', logs: '', aborted: false };
  const log = m => { if (currentTask) currentTask.logs += m + '\n'; };

  try {
    const pbfPath = path.join(DATA_DIR, 'pbf', `${region.id}.osm.pbf`);
    const mbtilesPath = path.join(DATA_DIR, 'mbtiles', `${region.id}.mbtiles`);
    const tempMbtilesPath = path.join(DATA_DIR, 'mbtiles', `${region.id}_temp.mbtiles`);

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
    const remoteMd5Raw = await fetchText(region.url + '.md5');
    const remoteMd5 = remoteMd5Raw.split(/\s+/)[0];

    currentTask.status = 'Building Vectors...';
    await runCommand('docker', [
      'run', '--rm', '--volumes-from', 'osm_manager', 'ghcr.io/onthegomap/planetiler:latest',
      `--osm-path=${pbfPath}`, `--output=${tempMbtilesPath}`, `--tmpdir=${TEMP_DIR}/work`,
      '--download', '--fetch-wikidata', '--nodemap-type=sparsearray', '--force'
    ], log);

    if (currentTask.aborted) throw new Error('Aborted');

    fs.renameSync(tempMbtilesPath, mbtilesPath);
    db.regions[region.id] = { localMd5: remoteMd5, remoteMd5, lastUpdate: new Date().toISOString() };
    saveDb();
    generateRegionStyle(region.id);
    fs.writeFileSync(TILESERVER_CONFIG_PATH, generateTomlConfig(db.regions));
    await runCommand('docker', ['kill', '-s', 'SIGHUP', process.env.TILESERVER_CONTAINER]).catch(() => {});

    currentTask.status = 'Completed';
    log('--- DONE ---');
    setTimeout(() => { if (currentTask && currentTask.status === 'Completed') currentTask = null; }, 10000);
  } catch (e) {
    if (currentTask) {
      currentTask.status = currentTask.aborted ? 'Cancelled' : 'Error';
      log(`ERROR: ${e.message}`);
    }
    setTimeout(() => { currentTask = null; }, 20000);
  }
});

app.post('/api/export', (req, res) => {
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

app.post('/api/import', upload.single('file'), (req, res) => {
  try {
    const zip = new AdmZip(req.file.path);
    const dbEntry = zip.getEntry('db.json');
    if (!dbEntry) throw new Error('No db.json');
    const importDb = JSON.parse(dbEntry.getData().toString());
    zip.getEntries().forEach(e => {
      if (e.entryName.endsWith('.mbtiles')) fs.writeFileSync(path.join(DATA_DIR, 'mbtiles', e.entryName), e.getData());
    });
    for (const id in importDb.regions) { db.regions[id] = importDb.regions[id]; generateRegionStyle(id); }
    saveDb();
    fs.writeFileSync(TILESERVER_CONFIG_PATH, generateTomlConfig(db.regions));
    runCommand('docker', ['kill', '-s', 'SIGHUP', process.env.TILESERVER_CONTAINER]).catch(() => {});
    res.json({ message: 'Imported' });
  } catch (e) { res.status(500).json({ error: e.message }); }
  finally { fs.unlinkSync(req.file.path); }
});

app.listen(PORT, () => console.log('Manager running on 3000'));
