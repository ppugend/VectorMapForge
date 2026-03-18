const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static('public'));

const DATA_DIR = process.env.DATA_DIR || '/osm_data';
const TEMP_DIR = process.env.TEMP_DIR || '/osm_temp';
const DB_PATH = path.join(DATA_DIR, 'db.json');
const TILESERVER_ROOT = path.join(DATA_DIR, 'tileserver');
const TILESERVER_CONFIG_PATH = path.join(TILESERVER_ROOT, 'config.toml');

// Function to generate TOML configuration for tileserver-rs
function generateTomlConfig(regionsDb) {
  let toml = `fonts = "/data/tileserver/fonts"
files = "/data/tileserver"

[server]
host = "0.0.0.0"
port = 8080
public_url = "http://localhost:8081"
cors_origins = ["*"]
`;
// Add sources
for (const regionId in regionsDb) {
  const r = regionsDb[regionId];
  if (r.localMd5) {
    toml += `
[[sources]]
id = "openmaptiles"
type = "mbtiles"
path = "/data/mbtiles/${regionId}.mbtiles"
`;
  }
}

// Add styles
for (const regionId in regionsDb) {
  const r = regionsDb[regionId];
  if (r.localMd5) {
    toml += `
[[styles]]
id = "${regionId}-pretty"
path = "/data/tileserver/styles/osm-bright/style.json"

[styles.tilejson]
center = [127.0, 37.5, 10]
zoom = 10
`;
  }
}
  return toml;
}

// Bootstrapping: Ensure volume structure exists
function bootstrap() {
  const folders = [
    path.join(DATA_DIR, 'pbf'),
    path.join(DATA_DIR, 'mbtiles'),
    path.join(DATA_DIR, 'sources'),
    TILESERVER_ROOT,
    path.join(TILESERVER_ROOT, 'styles'),
    path.join(TILESERVER_ROOT, 'fonts'),
    TEMP_DIR
  ];
  folders.forEach(f => {
    if (!fs.existsSync(f)) fs.mkdirSync(f, { recursive: true });
  });

  if (!fs.existsSync(TILESERVER_CONFIG_PATH)) {
    // Generate an empty config initially or from existing DB
    fs.writeFileSync(TILESERVER_CONFIG_PATH, generateTomlConfig(db.regions));
  }
}
const REGIONS = [
  { id: 'monaco', url: 'https://download.geofabrik.de/europe/monaco-latest.osm.pbf', name: 'Monaco' },
  { id: 'andorra', url: 'https://download.geofabrik.de/europe/andorra-latest.osm.pbf', name: 'Andorra' },
  { id: 'south-korea', url: 'https://download.geofabrik.de/asia/south-korea-latest.osm.pbf', name: 'South Korea' }
];

let db = { regions: {} };
if (fs.existsSync(DB_PATH)) {
  try { db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch (e) {}
}

bootstrap();

function saveDb() { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }

let currentTask = null;

function runCommand(command, args, onLog) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);
    proc.stdout.on('data', d => onLog && onLog(d.toString()));
    proc.stderr.on('data', d => onLog && onLog(d.toString()));
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Failed with code ${code}`)));
  });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.get : http.get;
    get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) return resolve(fetchText(res.headers.location));
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data.trim()));
    }).on('error', reject);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = url.startsWith('https') ? https.get : http.get;
    get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) return resolve(downloadFile(res.headers.location, dest));
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', e => { fs.unlink(dest, () => reject(e)); });
  });
}

app.get('/api/regions', (req, res) => {
  res.json(REGIONS.map(r => ({ ...r, status: db.regions[r.id] || {} })));
});

app.get('/api/status', (req, res) => res.json({ task: currentTask }));

app.post('/api/check-updates', async (req, res) => {
  res.json({ message: 'Checking...' });
  for (const region of REGIONS) {
    try {
      const remoteMd5Raw = await fetchText(region.url + '.md5');
      const remoteMd5 = remoteMd5Raw.split(/\s+/)[0];
      if (!db.regions[region.id]) db.regions[region.id] = {};
      db.regions[region.id].remoteMd5 = remoteMd5;
      db.regions[region.id].lastCheck = new Date().toISOString();
      saveDb();
    } catch (e) {}
  }
});

app.post('/api/update', async (req, res) => {
  const { regionId } = req.body;
  const region = REGIONS.find(r => r.id === regionId);
  if (!region || currentTask) return res.status(400).json({ error: 'Busy or invalid' });

  res.json({ message: 'Update started' });
  currentTask = { region: region.name, status: 'Downloading...', logs: '' };
  const log = m => currentTask.logs += m + '\n';

  try {
    const pbfPath = path.join(DATA_DIR, 'pbf', `${region.id}.osm.pbf`);
    const mbtilesPath = path.join(DATA_DIR, 'mbtiles', `${region.id}.mbtiles`);
    const tempMbtilesPath = path.join(DATA_DIR, 'mbtiles', `${region.id}_temp.mbtiles`);

    log(`Downloading ${region.url}...`);
    await downloadFile(region.url, pbfPath);
    const remoteMd5Raw = await fetchText(region.url + '.md5');
    const remoteMd5 = remoteMd5Raw.split(/\s+/)[0];

    currentTask.status = 'Building...';
    await runCommand('docker', [
      'run', '--rm', 
      '--volumes-from', 'osm_manager',
      'ghcr.io/onthegomap/planetiler:latest',
      `--osm-path=${pbfPath}`,
      `--output=${tempMbtilesPath}`,
      `--tmpdir=${TEMP_DIR}/work`,
      '--download', '--fetch-wikidata', '--nodemap-type=sparsearray', '--force'
    ], log);

    if (fs.existsSync(mbtilesPath)) fs.renameSync(mbtilesPath, `${mbtilesPath}.backup`);
    fs.renameSync(tempMbtilesPath, mbtilesPath);

    // Update DB
    db.regions[region.id] = { localMd5: remoteMd5, remoteMd5, lastUpdate: new Date().toISOString() };
    saveDb();

    // 4. Update TileServer config (TOML)
    log('Updating TileServer config...');
    const tomlConfig = generateTomlConfig(db.regions);
    fs.writeFileSync(TILESERVER_CONFIG_PATH, tomlConfig);

    // 5. Hot Reload TileServer GL
    log('Sending SIGHUP to TileServer RS for hot reload...');
    const containerName = process.env.TILESERVER_CONTAINER || 'osm_tileserver';
    await runCommand('docker', ['kill', '-s', 'SIGHUP', containerName]);

    log('Update finished successfully.');
    currentTask.status = 'Completed';
    setTimeout(() => currentTask = null, 10000);
  } catch (e) {
    if (currentTask) currentTask.status = 'Error';
    console.error(e);
  }
});

app.listen(PORT, () => console.log('Manager running on 3000'));
