const express = require('express');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static('public'));

const DB_PATH = '/data/db.json';
const TILESERVER_CONFIG_PATH = process.env.TILESERVER_CONFIG || '/tileserver/config.json';

// Hardcoded regions
const REGIONS = [
  { id: 'monaco', url: 'https://download.geofabrik.de/europe/monaco-latest.osm.pbf', name: 'Monaco' },
  { id: 'andorra', url: 'https://download.geofabrik.de/europe/andorra-latest.osm.pbf', name: 'Andorra' },
  { id: 'south-korea', url: 'https://download.geofabrik.de/asia/south-korea-latest.osm.pbf', name: 'South Korea' }
];

let db = { regions: {} };
if (fs.existsSync(DB_PATH)) {
  try {
    db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) {
    console.error('Error reading DB:', e);
  }
}

function saveDb() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

let currentTask = null;

function runCommand(command, args, onLog) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);
    proc.stdout.on('data', (data) => {
      const str = data.toString();
      if (onLog) onLog(str);
    });
    proc.stderr.on('data', (data) => {
      const str = data.toString();
      if (onLog) onLog(str);
    });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed with code ${code}`));
    });
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = url.startsWith('https') ? https.get : http.get;
    get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
         return resolve(downloadFile(response.headers.location, dest));
      }
      if (response.statusCode !== 200) {
        return reject(new Error(`Failed to get '${url}' (${response.statusCode})`));
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => reject(err));
    });
  });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.get : http.get;
    get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return resolve(fetchText(res.headers.location));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data.trim()));
    }).on('error', reject);
  });
}

app.get('/api/regions', (req, res) => {
  const regionsWithStatus = REGIONS.map(r => ({
    ...r,
    status: db.regions[r.id] || { localMd5: null, remoteMd5: null, lastCheck: null, lastUpdate: null }
  }));
  res.json(regionsWithStatus);
});

app.get('/api/status', (req, res) => {
  res.json({ task: currentTask });
});

app.post('/api/check-updates', async (req, res) => {
  if (currentTask) return res.status(400).json({ error: 'A task is already running' });
  
  res.json({ message: 'Update check started' });
  
  for (const region of REGIONS) {
    try {
      console.log(`Checking updates for ${region.id}...`);
      const remoteMd5Raw = await fetchText(region.url + '.md5');
      const remoteMd5 = remoteMd5Raw.split(/\s+/)[0];
      
      if (!db.regions[region.id]) db.regions[region.id] = {};
      db.regions[region.id].remoteMd5 = remoteMd5;
      db.regions[region.id].lastCheck = new Date().toISOString();
      
      const pbfPath = `/data/pbf/${region.id}.osm.pbf`;
      if (!fs.existsSync(pbfPath)) {
        db.regions[region.id].localMd5 = null;
      }
      
      saveDb();
    } catch (e) {
      console.error(`Failed to check updates for ${region.id}:`, e.message);
    }
  }
});

app.post('/api/update', async (req, res) => {
  const { regionId } = req.body;
  const region = REGIONS.find(r => r.id === regionId);
  
  if (!region) return res.status(404).json({ error: 'Region not found' });
  if (currentTask) return res.status(400).json({ error: 'A task is already running' });

  res.json({ message: 'Update started' });

  currentTask = { region: region.name, status: 'Downloading...', logs: '' };
  
  const log = (msg) => {
    currentTask.logs += msg + '\n';
  };

  try {
    const pbfPath = `/data/pbf/${region.id}.osm.pbf`;
    const mbtilesPath = `/data/mbtiles/${region.id}.mbtiles`;
    const tempMbtilesPath = `/data/mbtiles/${region.id}_temp.mbtiles`;

    // 1. Download PBF
    log(`Downloading ${region.url}...`);
    await downloadFile(region.url, pbfPath);
    
    // Also get the MD5
    const remoteMd5Raw = await fetchText(region.url + '.md5');
    const remoteMd5 = remoteMd5Raw.split(/\s+/)[0];
    
    log('Download complete.');

    // 2. Build with Planetiler
    currentTask.status = 'Building vectors...';
    log('Starting Planetiler build...');
    
    await runCommand('docker', [
      'run', '--rm', 
      '--volumes-from', 'osm_manager',
      'ghcr.io/onthegomap/planetiler:latest',
      `--osm-path=${pbfPath}`,
      `--output=${tempMbtilesPath}`,
      '--download',
      '--fetch-wikidata',
      '--nodemap-type=sparsearray',
      '--force'
    ], (data) => {
      const lines = currentTask.logs.split('\n').slice(-50);
      currentTask.logs = lines.join('\n') + data;
    });
    
    log('Build complete.');

    // 3. Swap files
    currentTask.status = 'Applying update...';
    if (fs.existsSync(mbtilesPath)) {
      fs.renameSync(mbtilesPath, `${mbtilesPath}.backup`);
    }
    fs.renameSync(tempMbtilesPath, mbtilesPath);
    
    // 4. Update TileServer config
    log('Updating TileServer config...');
    const configStr = fs.readFileSync(TILESERVER_CONFIG_PATH, 'utf8');
    const config = JSON.parse(configStr);
    
    if (!config.data) config.data = {};
    config.data[region.id] = { mbtiles: `${region.id}.mbtiles` };
    
    // Also add a pretty style for this region
    if (!config.styles) config.styles = {};
    config.styles[`${region.id}-pretty`] = {
      style: 'osm-bright/style.json',
      tilejson: {
        sources: {
          openmaptiles: {
            url: `mbtiles://${region.id}`
          }
        }
      }
    };
    
    fs.writeFileSync(TILESERVER_CONFIG_PATH, JSON.stringify(config, null, 2));
    
    // 5. Restart TileServer
    log('Restarting TileServer GL...');
    const containerName = process.env.TILESERVER_CONTAINER || 'osm_tileserver';
    await runCommand('docker', ['restart', containerName]);
    
    // 6. Update DB
    db.regions[region.id] = {
      ...db.regions[region.id],
      localMd5: remoteMd5,
      remoteMd5: remoteMd5,
      lastUpdate: new Date().toISOString(),
      lastCheck: new Date().toISOString()
    };
    saveDb();

    log('Update finished successfully.');
    currentTask.status = 'Completed';
    setTimeout(() => { currentTask = null; }, 10000);

  } catch (err) {
    console.error(err);
    if (currentTask) {
       currentTask.status = 'Error';
       currentTask.logs += '\nERROR: ' + err.message;
    }
    setTimeout(() => { currentTask = null; }, 20000);
  }
});

app.listen(PORT, () => {
  console.log(`Manager listening on port ${PORT}`);
});