// Costruisce gli eseguibili (Node SEA) con server e interfaccia incorporati.
//   yarn build          -> dist/YT-Downloader.exe              (Windows, serve una macchina Windows)
//   yarn build:linux    -> dist/YT-Downloader-linux-x64.tar.gz (Linux x64, funziona anche da Windows)
//   yarn build:all      -> entrambi
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const BUILD = path.join(ROOT, 'build');
const CACHE = path.join(BUILD, 'cache');
const PUBLIC = path.join(ROOT, 'public');
const BLOB = path.join(DIST, 'sea.blob');
const pkg = require(path.join(ROOT, 'package.json'));
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function run(cmd, args, cwd = ROOT) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`Comando fallito: ${cmd} ${args.join(' ')}`);
}

const mb = (file) => `${(fs.statSync(file).size / 1024 / 1024).toFixed(0)} MB`;

// ---------------------------------------------------------------- parti comuni
function makeBlob() {
  console.log('> icona');
  run(process.execPath, [path.join(__dirname, 'make-icon.js')]);

  console.log('> bundle');
  require('esbuild').buildSync({
    entryPoints: [path.join(ROOT, 'server.js')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: path.join(DIST, 'bundle.js'),
    legalComments: 'none',
  });

  console.log('> blob SEA');
  const assets = {};
  for (const f of fs.readdirSync(PUBLIC)) assets[f] = path.join('public', f);
  fs.writeFileSync(
    path.join(DIST, 'sea-config.json'),
    JSON.stringify({
      main: path.join('dist', 'bundle.js'),
      output: path.join('dist', 'sea.blob'),
      disableExperimentalSEAWarning: true,
      useCodeCache: false, // senza cache il blob è identico su ogni sistema operativo
      assets,
    })
  );
  run(process.execPath, ['--experimental-sea-config', path.join('dist', 'sea-config.json')]);
}

async function inject(binary) {
  console.log('> iniezione del blob');
  const { inject: postject } = require('postject');
  await postject(binary, 'NODE_SEA_BLOB', fs.readFileSync(BLOB), { sentinelFuse: SENTINEL });
}

// ---------------------------------------------------------------- Windows
async function buildWindows() {
  if (process.platform !== 'win32') throw new Error("La build dell'.exe richiede una macchina Windows.");
  const exe = path.join(DIST, 'YT-Downloader.exe');

  console.log('> copia di node.exe');
  fs.copyFileSync(process.execPath, exe);

  console.log('> icona e informazioni del file');
  const { rcedit } = require('rcedit');
  await rcedit(exe, {
    icon: path.join(BUILD, 'icon.ico'),
    'version-string': {
      ProductName: 'YT Downloader',
      FileDescription: 'YT Downloader - coda di download con yt-dlp',
      OriginalFilename: 'YT-Downloader.exe',
      InternalName: 'YT-Downloader',
    },
    'file-version': `${pkg.version}.0`,
    'product-version': `${pkg.version}.0`,
  });

  await inject(exe);
  console.log(`Fatto: ${exe} (${mb(exe)})`);
}

// ---------------------------------------------------------------- Linux
// Scarica (e verifica con SHA-256) il Node ufficiale per Linux della stessa versione di quello che esegue la build.
async function linuxNode() {
  const v = process.version;
  const name = `node-${v}-linux-x64`;
  const tarball = `${name}.tar.gz`;
  const bin = path.join(CACHE, `${name}.node`);
  if (fs.existsSync(bin)) return bin;
  fs.mkdirSync(CACHE, { recursive: true });

  console.log(`> scarico Node ${v} per Linux`);
  const base = `https://nodejs.org/dist/${v}`;
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const line = sums.split('\n').find((l) => l.endsWith(`  ${tarball}`));
  if (!line) throw new Error(`${tarball} non trovato su nodejs.org`);
  const expected = line.split(/\s+/)[0];

  const res = await fetch(`${base}/${tarball}`);
  if (!res.ok) throw new Error(`download di ${tarball} fallito (HTTP ${res.status})`);
  const data = Buffer.from(await res.arrayBuffer());
  const actual = crypto.createHash('sha256').update(data).digest('hex');
  if (actual !== expected) throw new Error(`SHA-256 di ${tarball} non corrisponde`);

  // estrazione con percorsi relativi: evita i problemi di "C:" con alcune versioni di tar su Windows
  fs.writeFileSync(path.join(CACHE, tarball), data);
  run('tar', ['-xzf', tarball, `${name}/bin/node`], CACHE);
  fs.renameSync(path.join(CACHE, name, 'bin', 'node'), bin);
  fs.rmSync(path.join(CACHE, name), { recursive: true, force: true });
  fs.rmSync(path.join(CACHE, tarball), { force: true });
  return bin;
}

// Archivio tar minimale (formato ustar) con un solo file eseguibile (modo 0755).
function tarSingleFile(name, content) {
  const header = Buffer.alloc(512);
  const put = (str, off, len) => header.write(str, off, len, 'ascii');
  put(name, 0, 100);
  put('0000755\0', 100, 8);
  put('0000000\0', 108, 8);
  put('0000000\0', 116, 8);
  put(content.length.toString(8).padStart(11, '0') + '\0', 124, 12);
  put(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12);
  put('        ', 148, 8); // somma di controllo: per ora spazi
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const b of header) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  const pad = Buffer.alloc((512 - (content.length % 512)) % 512);
  return Buffer.concat([header, content, pad, Buffer.alloc(1024)]);
}

async function buildLinux() {
  const tmp = path.join(DIST, 'YT-Downloader');
  fs.copyFileSync(await linuxNode(), tmp);
  await inject(tmp);

  console.log('> archivio tar.gz');
  const out = path.join(DIST, 'YT-Downloader-linux-x64.tar.gz');
  fs.writeFileSync(out, zlib.gzipSync(tarSingleFile('YT-Downloader', fs.readFileSync(tmp)), { level: 9 }));
  fs.rmSync(tmp, { force: true });
  console.log(`Fatto: ${out} (${mb(out)})`);
}

// ---------------------------------------------------------------- main
async function main() {
  const arg = process.argv[2] || (process.platform === 'win32' ? 'win' : 'linux');
  const wanted = { win: ['win'], linux: ['linux'], all: ['win', 'linux'] }[arg];
  if (!wanted) throw new Error(`Bersaglio sconosciuto "${arg}": usa win, linux o all.`);

  fs.mkdirSync(DIST, { recursive: true });
  for (const f of fs.readdirSync(DIST)) fs.rmSync(path.join(DIST, f), { recursive: true, force: true });
  makeBlob();

  if (wanted.includes('win')) await buildWindows();
  if (wanted.includes('linux')) await buildLinux();

  for (const tmp of ['bundle.js', 'sea.blob', 'sea-config.json']) fs.rmSync(path.join(DIST, tmp), { force: true });
}

main().catch((e) => {
  console.error(`\nBuild fallita: ${e.message}`);
  process.exit(1);
});
