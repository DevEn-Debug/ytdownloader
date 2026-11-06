// Costruisce dist/YT-Downloader.exe: un unico eseguibile Windows (Node SEA) con server e interfaccia incorporati.
//   yarn build
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PUBLIC = path.join(ROOT, 'public');
const EXE = path.join(DIST, 'YT-Downloader.exe');
const pkg = require(path.join(ROOT, 'package.json'));

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`Comando fallito: ${cmd} ${args.join(' ')}`);
}

async function main() {
  if (process.platform !== 'win32') throw new Error('La build dell\'.exe è supportata solo su Windows.');
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

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
      useCodeCache: false,
      assets,
    })
  );
  run(process.execPath, ['--experimental-sea-config', path.join('dist', 'sea-config.json')]);

  console.log('> copia di node.exe');
  fs.copyFileSync(process.execPath, EXE);

  console.log('> icona e informazioni del file');
  const { rcedit } = require('rcedit');
  await rcedit(EXE, {
    icon: path.join(ROOT, 'build', 'icon.ico'),
    'version-string': {
      ProductName: 'YT Downloader',
      FileDescription: 'YT Downloader - coda di download con yt-dlp',
      OriginalFilename: 'YT-Downloader.exe',
      InternalName: 'YT-Downloader',
    },
    'file-version': `${pkg.version}.0`,
    'product-version': `${pkg.version}.0`,
  });

  console.log('> iniezione del blob');
  const { inject } = require('postject');
  await inject(EXE, 'NODE_SEA_BLOB', fs.readFileSync(path.join(DIST, 'sea.blob')), {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  });

  for (const tmp of ['bundle.js', 'sea.blob', 'sea-config.json']) fs.rmSync(path.join(DIST, tmp), { force: true });
  const mb = (fs.statSync(EXE).size / 1024 / 1024).toFixed(0);
  console.log(`\nFatto: ${EXE} (${mb} MB)`);
}

main().catch((e) => {
  console.error(`\nBuild fallita: ${e.message}`);
  process.exit(1);
});
