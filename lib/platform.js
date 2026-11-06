// Tutto ciò che cambia tra Windows e Linux: cartella dei dati, selettore di cartelle,
// apertura di cartelle e finestra dell'app, chiusura dei processi, console.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

// Cartella che contiene i dati dell'utente (la nostra sta in "<qui>/YT Downloader").
function userDataHome() {
  if (isWin) return process.env.APPDATA || os.homedir();
  if (isMac) return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
}

function hasCommand(cmd) {
  const r = spawnSync(isWin ? 'where' : 'which', [cmd], { stdio: 'ignore' });
  return r.status === 0;
}

// Avvia un programma "e dimenticalo". Se non esiste non deve far crollare l'app.
function launch(cmd, args) {
  try {
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    p.on('error', () => {});
    p.unref();
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ selettore di cartelle
// Risolve con { path } | { canceled: true } | { error }.
function runPicker(cmd, args, env) {
  return new Promise((resolve) => {
    let out = '';
    let p;
    try {
      p = spawn(cmd, args, { env: { ...process.env, ...env } });
    } catch {
      return resolve(null);
    }
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(null)); // programma non installato
    p.on('close', () => resolve(out.trim() ? { path: out.trim() } : { canceled: true }));
  });
}

async function pickFolder(startDir) {
  const title = 'Scegli la cartella di destinazione dei download';

  if (isWin) {
    const script = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$f = New-Object System.Windows.Forms.FolderBrowserDialog',
      `$f.Description = '${title}'`,
      '$f.ShowNewFolderButton = $true',
      'if ($env:YTDL_START -and (Test-Path -LiteralPath $env:YTDL_START)) { $f.SelectedPath = $env:YTDL_START }',
      '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }',
      "if ($f.ShowDialog($owner) -eq 'OK') { Write-Output $f.SelectedPath }",
    ].join('; ');
    const r = await runPicker('powershell', ['-NoProfile', '-STA', '-Command', script], { YTDL_START: startDir || '' });
    return r || { error: 'Impossibile aprire il selettore di cartelle: scrivi il percorso a mano.' };
  }

  // Linux: zenity (GNOME e simili) oppure kdialog (KDE)
  const start = startDir && fs.existsSync(startDir) ? startDir : os.homedir();
  const attempts = [
    ['zenity', ['--file-selection', '--directory', `--title=${title}`, `--filename=${start}${path.sep}`]],
    ['kdialog', ['--getexistingdirectory', start, '--title', title]],
  ];
  for (const [cmd, args] of attempts) {
    const r = await runPicker(cmd, args);
    if (r) return r;
  }
  return { error: 'Nessun selettore di cartelle disponibile (installa zenity o kdialog): scrivi il percorso a mano nel campo.' };
}

// ------------------------------------------------------------------ apertura di cartelle e finestra
function openFolder(dir) {
  if (isWin) return launch('explorer', [dir]);
  return launch(isMac ? 'open' : 'xdg-open', [dir]);
}

// Apre l'interfaccia come finestra "app" (senza barra degli indirizzi) con Edge o Chrome/Chromium;
// se non li trova usa il browser predefinito. NO_OPEN=1 la disattiva.
function openUI(addr) {
  if (process.env.NO_OPEN) return;
  const appArgs = [`--app=${addr}`, '--window-size=860,760'];

  if (isWin) {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    const rels = [
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
    ];
    for (const rel of rels) {
      for (const r of roots) {
        const exe = path.join(r, ...rel);
        if (fs.existsSync(exe)) return launch(exe, appArgs);
      }
    }
    return launch('cmd', ['/c', 'start', '', addr]);
  }

  if (isMac) return launch('open', [addr]);

  // Linux: senza ambiente grafico non c'è nulla da aprire, l'indirizzo è già stampato in console.
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return;
  const browsers = [
    'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
    'microsoft-edge', 'microsoft-edge-stable', 'brave-browser',
  ];
  for (const b of browsers) if (hasCommand(b)) return launch(b, appArgs);
  launch('xdg-open', [addr]);
}

// ------------------------------------------------------------------ processi e console
// I download partono in un gruppo di processi a parte (Linux), così si chiude tutto l'albero: yt-dlp + ffmpeg.
const DETACH_CHILDREN = !isWin;

function killTree(proc) {
  if (!proc || proc.killed) return;
  if (isWin) {
    spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    process.kill(-proc.pid, 'SIGTERM');
  } catch {
    proc.kill('SIGTERM');
  }
}

// Da .exe su Windows: a setup finito riduce a icona la finestra della console (resta nella barra delle applicazioni).
// Si risale alla finestra "proprietaria" perché con Windows Terminal la console è ospitata da un'altra finestra.
function minimizeConsole() {
  if (!isWin || process.env.NO_OPEN) return;
  const script = [
    "Add-Type -Namespace W -Name N -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow(); [DllImport(\"user32.dll\")] public static extern IntPtr GetAncestor(IntPtr h, uint f); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int c);'",
    '$h = [W.N]::GetConsoleWindow()',
    'if ($h -ne [IntPtr]::Zero) { $o = [W.N]::GetAncestor($h, 3); if ($o -ne [IntPtr]::Zero) { $h = $o }; [void][W.N]::ShowWindow($h, 7) }',
  ].join('; ');
  // niente windowsHide: il processo figlio deve restare agganciato alla stessa console
  spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' }).unref();
}

module.exports = {
  isWin,
  isMac,
  userDataHome,
  hasCommand,
  pickFolder,
  openFolder,
  openUI,
  killTree,
  minimizeConsole,
  DETACH_CHILDREN,
};
