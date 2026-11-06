const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const os = require('node:os');
const { ensureDeps } = require('./lib/ensure-deps');

// Quando gira come .exe (Node SEA) i file della pagina sono incorporati nell'eseguibile
// e i dati dell'utente vivono in %APPDATA%; da sorgente restano nella cartella del progetto.
const sea = (() => {
  try {
    return require('node:sea');
  } catch {
    return null;
  }
})();
const PACKAGED = Boolean(sea && sea.isSea());

const PORT = Number(process.env.PORT) || 3000;
const HOST = '127.0.0.1';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const APP_DATA = PACKAGED ? path.join(process.env.APPDATA || os.homedir(), 'YT Downloader') : ROOT;
const DEFAULT_DOWNLOAD_DIR =
  process.env.DOWNLOAD_DIR ||
  (PACKAGED ? path.join(os.homedir(), 'Videos', 'YT Downloader') : path.join(ROOT, 'downloads'));
const DATA_DIR = process.env.DATA_DIR || APP_DATA; // dove vivono queue.json e settings.json
fs.mkdirSync(DATA_DIR, { recursive: true });
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// ------------------------------------------------------------ impostazioni
// downloadDir è la cartella "globale": viene assegnata ai video al momento dell'aggiunta in coda.
let settings = { downloadDir: DEFAULT_DOWNLOAD_DIR };

function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (s && typeof s.downloadDir === 'string' && s.downloadDir) settings.downloadDir = s.downloadDir;
  } catch {
    /* prima esecuzione */
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('Impossibile salvare le impostazioni:', e.message);
  }
}

// Apre il selettore di cartelle nativo di Windows (il server gira sul PC locale).
function pickFolder(startDir) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    const script = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$f = New-Object System.Windows.Forms.FolderBrowserDialog',
      "$f.Description = 'Scegli la cartella di destinazione dei download'",
      '$f.ShowNewFolderButton = $true',
      'if ($env:YTDL_START -and (Test-Path -LiteralPath $env:YTDL_START)) { $f.SelectedPath = $env:YTDL_START }',
      '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }',
      "if ($f.ShowDialog($owner) -eq 'OK') { Write-Output $f.SelectedPath }",
    ].join('; ');
    const p = spawn('powershell', ['-NoProfile', '-STA', '-Command', script], {
      env: { ...process.env, YTDL_START: startDir || '' },
      windowsHide: false,
    });
    let out = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(null));
    p.on('close', () => resolve(out.trim() || null));
  });
}

// ---------------------------------------------------------------- stato coda
/** @type {Array<{id:string,url:string,title:string,status:string,percent:number,speed:string,eta:string,error:string,file:string,addedAt:number}>} */
let queue = [];
let running = false; // true = la coda è "avviata" e processa gli elementi uno alla volta
let current = null; // { item, proc }
const clients = new Set();

function loadQueue() {
  try {
    queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    // un download interrotto da un riavvio torna in coda
    for (const it of queue) if (it.status === 'downloading') it.status = 'queued';
  } catch {
    queue = [];
  }
}

function saveQueue() {
  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
  } catch (e) {
    console.error('Impossibile salvare la coda:', e.message);
  }
}

function snapshot() {
  return { running, downloadDir: settings.downloadDir, queue };
}

function broadcast() {
  const data = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of clients) res.write(data);
}

let saveTimer = null;
function changed() {
  broadcast();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveQueue, 300);
}

// ---------------------------------------------------------------- yt-dlp
// Legge titolo, copertina e durata senza scaricare nulla.
// Le richieste sono messe in fila (una alla volta) per non martellare YouTube.
const metaQueue = [];
let metaBusy = false;

function fetchMeta(item) {
  metaQueue.push(item);
  pumpMeta();
}

function pumpMeta() {
  if (metaBusy) return;
  const item = metaQueue.shift();
  if (!item) return;
  metaBusy = true;
  const done = () => {
    metaBusy = false;
    pumpMeta();
  };
  const p = spawn(
    'yt-dlp',
    [
      '--no-playlist', '--no-warnings', '--skip-download',
      '--print', '%(title)s',
      '--print', '%(thumbnail)s',
      '--print', '%(duration_string)s',
      item.url,
    ],
    { windowsHide: true }
  );
  let out = '';
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (d) => (out += d));
  p.on('error', done);
  p.on('close', () => {
    const [title, thumb, duration] = out.split(/\r?\n/).map((s) => s.trim());
    const ok = (s) => s && s !== 'NA';
    if (ok(title) && item.title === item.url) item.title = title;
    item.thumb = ok(thumb) && isHttpUrl(thumb) ? thumb : '';
    // yt-dlp scrive "19" per 19 secondi: lo portiamo a "0:19"
    item.duration = ok(duration) ? (/^\d+$/.test(duration) ? `0:${duration.padStart(2, '0')}` : duration) : '';
    changed();
    done();
  });
}

function killTree(proc) {
  if (!proc || proc.killed) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
  } else {
    proc.kill('SIGTERM');
  }
}

function startItem(item) {
  const dir = item.dir || settings.downloadDir;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    item.status = 'error';
    item.error = `Cartella di destinazione non utilizzabile: ${e.message}`;
    changed();
    return next();
  }
  item.status = 'downloading';
  item.percent = 0;
  item.speed = '';
  item.eta = '';
  item.error = '';

  const args = [
    '-f', 'bestvideo+bestaudio/best',
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--windows-filenames',
    '--no-colors',
    '--newline',
    '--progress-template', 'download:[PROG]|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '-o', path.join(dir, '%(title)s [%(id)s].%(ext)s'),
    item.url,
  ];

  const proc = spawn('yt-dlp', args, { windowsHide: true });
  current = { item, proc, canceled: false };
  const ctx = current;
  let lastErr = '';
  let lastTick = 0;

  const onLine = (line) => {
    line = line.trim();
    if (!line) return;
    if (line.startsWith('[PROG]|')) {
      const [, pct, speed, eta] = line.split('|');
      const n = parseFloat(pct);
      if (!Number.isNaN(n)) item.percent = n;
      item.speed = (speed || '').trim().replace(/^Unknown.*/, '');
      item.eta = (eta || '').trim().replace(/^Unknown.*/, '');
      const now = Date.now();
      if (now - lastTick > 250) {
        lastTick = now;
        changed();
      }
      return;
    }
    const merge = line.match(/^\[Merger\] Merging formats into "(.+)"$/);
    if (merge) item.file = merge[1];
    const dest = line.match(/^\[download\] Destination: (.+)$/);
    if (dest && !item.file) item.file = dest[1];
    const already = line.match(/^\[download\] (.+) has already been downloaded$/);
    if (already) item.file = already[1];
    if (/^ERROR/.test(line)) lastErr = line;
  };

  for (const stream of [proc.stdout, proc.stderr]) {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      lines.forEach(onLine);
    });
    stream.on('end', () => buf && onLine(buf));
  }

  proc.on('error', (e) => {
    item.status = 'error';
    item.error = e.message;
    current = null;
    changed();
    next();
  });

  proc.on('close', (code) => {
    if (current === ctx) current = null;
    if (ctx.canceled) {
      item.status = 'canceled';
    } else if (code === 0) {
      item.status = 'done';
      item.percent = 100;
      item.speed = '';
      item.eta = '';
    } else {
      item.status = 'error';
      item.error = lastErr || `yt-dlp è terminato con codice ${code}`;
    }
    changed();
    next();
  });

  changed();
}

function next() {
  if (!running || current) return;
  const item = queue.find((i) => i.status === 'queued');
  if (!item) {
    running = false;
    changed();
    return;
  }
  startItem(item);
}

// ---------------------------------------------------------------- API
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('Body troppo grande'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function isHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const action = parts[1];
  const id = parts[2];
  const find = () => queue.find((i) => i.id === id);

  if (req.method === 'GET' && action === 'events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (req.method === 'GET' && action === 'state') return json(res, 200, snapshot());

  if (req.method === 'POST' && action === 'add') {
    const body = await readBody(req);
    const urls = (body.urls || [])
      .map((u) => String(u).trim())
      .filter(Boolean);
    const added = [];
    const skipped = [];
    for (const u of urls) {
      if (!isHttpUrl(u)) {
        skipped.push({ url: u, reason: 'URL non valido' });
        continue;
      }
      if (queue.some((i) => i.url === u && ['queued', 'downloading'].includes(i.status))) {
        skipped.push({ url: u, reason: 'già in coda' });
        continue;
      }
      const item = {
        id: crypto.randomUUID(),
        url: u,
        title: u,
        status: 'queued',
        percent: 0,
        speed: '',
        eta: '',
        error: '',
        file: '',
        thumb: undefined,
        duration: '',
        dir: settings.downloadDir,
        addedAt: Date.now(),
      };
      queue.push(item);
      added.push(item.id);
      fetchMeta(item);
    }
    changed();
    return json(res, 200, { added: added.length, skipped });
  }

  if (req.method === 'POST' && action === 'start') {
    running = true;
    next();
    changed();
    return json(res, 200, { ok: true });
  }

  // Pausa: finisce il download in corso, poi non ne parte un altro.
  if (req.method === 'POST' && action === 'pause') {
    running = false;
    changed();
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && action === 'cancel') {
    const item = find();
    if (!item) return json(res, 404, { error: 'Elemento non trovato' });
    if (current && current.item === item) {
      current.canceled = true;
      killTree(current.proc);
    } else if (item.status === 'queued') {
      item.status = 'canceled';
      changed();
    }
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && action === 'retry') {
    const item = find();
    if (!item) return json(res, 404, { error: 'Elemento non trovato' });
    if (['error', 'canceled', 'done'].includes(item.status)) {
      item.status = 'queued';
      item.percent = 0;
      item.error = '';
      item.file = '';
      changed();
      next();
    }
    return json(res, 200, { ok: true });
  }

  if (req.method === 'DELETE' && action === 'item') {
    const item = find();
    if (!item) return json(res, 404, { error: 'Elemento non trovato' });
    if (current && current.item === item) return json(res, 409, { error: 'Annulla prima il download in corso' });
    queue = queue.filter((i) => i !== item);
    changed();
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && action === 'clear-finished') {
    queue = queue.filter((i) => !['done', 'canceled'].includes(i.status));
    changed();
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && action === 'open-folder') {
    const body = await readBody(req);
    const dir = body.dir || settings.downloadDir;
    fs.mkdirSync(dir, { recursive: true });
    if (process.platform === 'win32') spawn('explorer', [dir], { detached: true, stdio: 'ignore' }).unref();
    return json(res, 200, { ok: true });
  }

  // Imposta la cartella globale (vale per i video aggiunti da ora in poi).
  if (req.method === 'POST' && action === 'settings') {
    const body = await readBody(req);
    const dir = String(body.downloadDir || '').trim();
    if (!dir || !path.isAbsolute(dir)) {
      return json(res, 400, { error: 'Inserisci un percorso assoluto (es. D:\\Video)' });
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      return json(res, 400, { error: `Impossibile usare la cartella: ${e.message}` });
    }
    settings.downloadDir = path.normalize(dir);
    saveSettings();
    changed();
    return json(res, 200, { ok: true, downloadDir: settings.downloadDir });
  }

  // Apre il selettore nativo e, se l'utente conferma, imposta la cartella globale.
  if (req.method === 'POST' && action === 'pick-folder') {
    const picked = await pickFolder(settings.downloadDir);
    if (!picked) return json(res, 200, { canceled: true });
    settings.downloadDir = path.normalize(picked);
    saveSettings();
    changed();
    return json(res, 200, { ok: true, downloadDir: settings.downloadDir });
  }

  json(res, 404, { error: 'Endpoint non trovato' });
}

// ---------------------------------------------------------------- static + server
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);

  if (PACKAGED) {
    let data;
    try {
      data = Buffer.from(sea.getAsset(rel));
    } catch {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(rel)] || 'application/octet-stream' });
    res.end(data);
    return;
  }

  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// Apre l'interfaccia come finestra "app" (senza barra degli indirizzi) con Edge o Chrome;
// se non li trova usa il browser predefinito.
function openUI(addr) {
  if (process.platform !== 'win32' || process.env.NO_OPEN) return;
  const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const rels = [
    ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
    ['Google', 'Chrome', 'Application', 'chrome.exe'],
  ];
  for (const rel of rels) {
    for (const r of roots) {
      const exe = path.join(r, ...rel);
      if (fs.existsSync(exe)) {
        spawn(exe, [`--app=${addr}`, '--window-size=860,760'], { detached: true, stdio: 'ignore' }).unref();
        return;
      }
    }
  }
  spawn('cmd', ['/c', 'start', '', addr], { detached: true, stdio: 'ignore' }).unref();
}

// Da .exe: a setup finito riduce a icona la finestra della console (resta nella barra delle applicazioni).
// Si risale alla finestra "proprietaria" perché con Windows Terminal la console è ospitata da un'altra finestra.
function minimizeConsole() {
  if (!PACKAGED || process.platform !== 'win32' || process.env.NO_OPEN) return;
  const script = [
    "Add-Type -Namespace W -Name N -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow(); [DllImport(\"user32.dll\")] public static extern IntPtr GetAncestor(IntPtr h, uint f); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int c);'",
    '$h = [W.N]::GetConsoleWindow()',
    'if ($h -ne [IntPtr]::Zero) { $o = [W.N]::GetAncestor($h, 3); if ($o -ne [IntPtr]::Zero) { $h = $o }; [void][W.N]::ShowWindow($h, 7) }',
  ].join('; ');
  // niente windowsHide: il processo figlio deve restare agganciato alla stessa console
  spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' }).unref();
}

// Errore fatale: da .exe la console si chiuderebbe subito, quindi la teniamo aperta per leggere il messaggio.
function fatal(message) {
  console.error(`\n${message}`);
  if (!PACKAGED) process.exit(1);
  console.error('\nPremi Invio per chiudere.');
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(1));
}

function main() {
  if (PACKAGED) process.title = 'YT Downloader';
  try {
    ensureDeps();
  } catch (e) {
    return fatal(`[setup] ${e.message}`);
  }

  loadSettings();
  loadQueue();
  // video già in coda da prima di questa funzione (o il cui recupero era fallito): riprova
  for (const it of queue) if (it.thumb === undefined && it.status !== 'done') fetchMeta(it);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else serveStatic(req, res, url);
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });

  const addr = `http://localhost:${PORT}`;

  server.on('error', async (e) => {
    if (e.code !== 'EADDRINUSE') return fatal(e.message);
    // Porta occupata: se è un'altra copia di questa app, ne riapriamo semplicemente la finestra.
    try {
      const r = await fetch(`${addr}/api/state`);
      const s = await r.json();
      if (Array.isArray(s.queue)) {
        console.log(`YT Downloader è già in esecuzione su ${addr}: riapro la finestra.`);
        openUI(addr);
        return process.exit(0);
      }
    } catch {
      /* non è la nostra app */
    }
    fatal(`Porta ${PORT} già in uso da un altro programma (puoi usare PORT=xxxx).`);
  });

  server.listen(PORT, HOST, () => {
    console.log(`\nYT Downloader pronto su ${addr}`);
    console.log(`Cartella download: ${settings.downloadDir}`);
    console.log(
      PACKAGED
        ? "Questa finestra si riduce a icona: per fermare l'app chiudila dalla barra delle applicazioni.\n"
        : "Premi Ctrl+C per fermare l'app.\n"
    );
    openUI(addr);
    setTimeout(minimizeConsole, 2000);
  });

  const shutdown = () => {
    if (current) {
      current.canceled = true;
      killTree(current.proc);
    }
    saveQueue();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
