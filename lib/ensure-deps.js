// Verifica che yt-dlp e ffmpeg siano disponibili e, se mancano, li installa.
//  - Windows: con winget.
//  - Linux:   scarica i binari ufficiali in "<dati utente>/YT Downloader/bin" (nessun sudo).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isWin, userDataHome } = require('./platform');

const isLinux = process.platform === 'linux';
const arm = process.arch === 'arm64';

const DEPS = [
  { name: 'yt-dlp', cmd: 'yt-dlp', args: ['--version'], wingetId: 'yt-dlp.yt-dlp' },
  { name: 'ffmpeg', cmd: 'ffmpeg', args: ['-version'], wingetId: 'Gyan.FFmpeg' },
];

function works(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'ignore', windowsHide: true });
  return !r.error && r.status === 0;
}

// ---------------------------------------------------------------- Windows
// Dopo un'installazione con winget il PATH del processo corrente non è aggiornato:
// rileggiamo PATH di macchina e utente dal registro e aggiungiamo la cartella dei link di winget.
function refreshPathWindows() {
  const ps = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
    ],
    { encoding: 'utf8', windowsHide: true }
  );
  const extra = [];
  if (ps.status === 0 && ps.stdout) extra.push(...ps.stdout.trim().split(';'));
  if (process.env.LOCALAPPDATA) {
    extra.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'));
  }
  const current = (process.env.PATH || '').split(';');
  process.env.PATH = [...new Set([...current, ...extra].filter(Boolean))].join(';');
}

function wingetInstall(id) {
  const r = spawnSync(
    'winget',
    [
      'install',
      '--id', id,
      '-e',
      '--accept-package-agreements',
      '--accept-source-agreements',
      '--disable-interactivity',
    ],
    { stdio: 'inherit', windowsHide: true }
  );
  // 0 = ok; 0x8A15002B (-1978335189) = già installato / nessun aggiornamento
  return r.status === 0 || r.status === -1978335189;
}

function ensureWindows() {
  refreshPathWindows();
  for (const dep of DEPS) {
    if (works(dep.cmd, dep.args)) {
      console.log(`[setup] ${dep.name} OK`);
      continue;
    }
    console.log(`[setup] ${dep.name} non trovato.`);
    if (!works('winget', ['--version'])) {
      throw new Error(
        `${dep.name} non è installato e winget non è disponibile. Installalo manualmente e riprova.`
      );
    }
    console.log(`[setup] Installo ${dep.name} con winget...`);
    if (!wingetInstall(dep.wingetId)) {
      throw new Error(`Installazione di ${dep.name} fallita.`);
    }
    refreshPathWindows();
    if (!works(dep.cmd, dep.args)) {
      throw new Error(
        `${dep.name} installato ma non ancora raggiungibile. Chiudi e riapri il terminale, poi rilancia l'app.`
      );
    }
    console.log(`[setup] ${dep.name} installato.`);
  }
}

// ---------------------------------------------------------------- Linux
async function download(url, dest, label) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download di ${label} fallito (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(dest);
  let got = 0;
  let lastPct = -1;
  for await (const chunk of res.body) {
    out.write(chunk);
    got += chunk.length;
    const pct = total ? Math.floor((got / total) * 10) * 10 : -1;
    if (pct !== lastPct && total) {
      lastPct = pct;
      process.stdout.write(`\r[setup] Scarico ${label}: ${pct}%   `);
    }
  }
  await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  if (total) process.stdout.write('\n');
}

const MANUAL_HINT =
  'Installalo con il gestore pacchetti della tua distribuzione (es. "sudo apt install ffmpeg" oppure "sudo pacman -S ffmpeg") e rilancia l\'app.';

async function installYtDlpLinux(binDir) {
  const asset = arm ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
  const dest = path.join(binDir, 'yt-dlp');
  await download(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`, dest, 'yt-dlp');
  fs.chmodSync(dest, 0o755);
}

async function installFfmpegLinux(binDir) {
  const build = arm ? 'arm64' : 'amd64';
  const archive = path.join(binDir, 'ffmpeg.tar.xz');
  const tmp = path.join(binDir, '.ffmpeg-tmp');
  await download(`https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${build}-static.tar.xz`, archive, 'ffmpeg');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const r = spawnSync('tar', ['-xJf', archive, '-C', tmp], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`impossibile estrarre ffmpeg (servono "tar" e "xz"). ${MANUAL_HINT}`);
  const root = path.join(tmp, fs.readdirSync(tmp)[0]);
  for (const bin of ['ffmpeg', 'ffprobe']) {
    const src = path.join(root, bin);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(binDir, bin));
    fs.chmodSync(path.join(binDir, bin), 0o755);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(archive, { force: true });
}

async function ensureLinux() {
  const binDir = path.join(userDataHome(), 'YT Downloader', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH || ''}`;

  const installers = { 'yt-dlp': installYtDlpLinux, ffmpeg: installFfmpegLinux };
  for (const dep of DEPS) {
    if (works(dep.cmd, dep.args)) {
      console.log(`[setup] ${dep.name} OK`);
      continue;
    }
    console.log(`[setup] ${dep.name} non trovato: lo scarico in ${binDir}`);
    try {
      await installers[dep.name](binDir);
    } catch (e) {
      throw new Error(`${dep.name}: ${e.message}. ${MANUAL_HINT}`);
    }
    if (!works(dep.cmd, dep.args)) {
      throw new Error(`${dep.name} scaricato ma non si avvia. ${MANUAL_HINT}`);
    }
    console.log(`[setup] ${dep.name} installato.`);
  }
}

// ---------------------------------------------------------------- altri sistemi
function ensureOther() {
  for (const dep of DEPS) {
    if (works(dep.cmd, dep.args)) {
      console.log(`[setup] ${dep.name} OK`);
    } else {
      throw new Error(
        `${dep.name} non trovato. Su questo sistema va installato a mano (es. "brew install yt-dlp ffmpeg").`
      );
    }
  }
}

async function ensureDeps() {
  if (isWin) return ensureWindows();
  if (isLinux) return ensureLinux();
  return ensureOther();
}

module.exports = { ensureDeps };
