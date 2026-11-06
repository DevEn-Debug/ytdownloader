// Verifica che yt-dlp e ffmpeg siano disponibili; se mancano li installa con winget.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const isWin = process.platform === 'win32';

const DEPS = [
  { name: 'yt-dlp', cmd: 'yt-dlp', args: ['--version'], wingetId: 'yt-dlp.yt-dlp' },
  { name: 'ffmpeg', cmd: 'ffmpeg', args: ['-version'], wingetId: 'Gyan.FFmpeg' },
];

function works(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'ignore', windowsHide: true });
  return !r.error && r.status === 0;
}

// Dopo un'installazione con winget il PATH del processo corrente non è aggiornato:
// rileggiamo PATH di macchina e utente dal registro e aggiungiamo la cartella dei link di winget.
function refreshPath() {
  if (!isWin) return;
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
  const merged = [...new Set([...current, ...extra].filter(Boolean))];
  process.env.PATH = merged.join(';');
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

function ensureDeps() {
  refreshPath();
  for (const dep of DEPS) {
    if (works(dep.cmd, dep.args)) {
      console.log(`[setup] ${dep.name} OK`);
      continue;
    }
    console.log(`[setup] ${dep.name} non trovato.`);
    if (!isWin || !works('winget', ['--version'])) {
      throw new Error(
        `${dep.name} non è installato e winget non è disponibile. Installalo manualmente e riprova.`
      );
    }
    console.log(`[setup] Installo ${dep.name} con winget...`);
    if (!wingetInstall(dep.wingetId)) {
      throw new Error(`Installazione di ${dep.name} fallita.`);
    }
    refreshPath();
    if (!works(dep.cmd, dep.args)) {
      throw new Error(
        `${dep.name} installato ma non ancora raggiungibile. Chiudi e riapri il terminale, poi rilancia "yarn dev".`
      );
    }
    console.log(`[setup] ${dep.name} installato.`);
  }
}

module.exports = { ensureDeps };
