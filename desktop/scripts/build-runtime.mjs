import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, '..');
const wheelsDir = join(desktopRoot, 'python', 'wheels');
const requirementsPath = join(wheelsDir, 'requirements.txt');
const runtimeDir = join(desktopRoot, 'python', 'runtime');
const stagingDir = `${runtimeDir}.staging`;
const markerPath = join(runtimeDir, '.runtime-state.json');
const pythonVersion = process.env.XTRALAB_PYTHON ?? '3.14';
const ripgrepVersion = process.env.XTRALAB_RIPGREP_VERSION ?? '15.1.0';
const markerSchema = 2;

function run(command, args) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', rejectP);
    child.on('exit', code => {
      if (code === 0) {
        resolveP();
      } else {
        rejectP(
          new Error(`${command} ${args.join(' ')} exited with code ${code}`)
        );
      }
    });
  });
}

function findLatestWheel(prefix, label) {
  const candidates = readdirSync(wheelsDir)
    .filter(name => name.startsWith(prefix) && name.endsWith('.whl'))
    .map(name => {
      const wheelPath = join(wheelsDir, name);
      return { name, path: wheelPath, mtimeMs: statSync(wheelPath).mtimeMs };
    });
  if (candidates.length === 0) {
    throw new Error(
      `No ${label} wheel found in ${wheelsDir}. Run "pnpm build:python" first.`
    );
  }
  candidates.sort((left, right) => {
    if (right.mtimeMs !== left.mtimeMs) {
      return right.mtimeMs - left.mtimeMs;
    }
    return right.name.localeCompare(left.name);
  });
  return candidates[0];
}

function ripgrepReleaseAsset(version) {
  const target = `${process.platform}-${process.arch}`;
  // Linux uses the statically linked musl build so the AppImage's bundled rg
  // runs regardless of the host's glibc version.
  const assets = {
    'darwin-arm64': `ripgrep-${version}-aarch64-apple-darwin.tar.gz`,
    'darwin-x64': `ripgrep-${version}-x86_64-apple-darwin.tar.gz`,
    'linux-x64': `ripgrep-${version}-x86_64-unknown-linux-musl.tar.gz`,
    'linux-arm64': `ripgrep-${version}-aarch64-unknown-linux-gnu.tar.gz`
  };
  const asset = assets[target];
  if (asset === undefined) {
    throw new Error(`No ripgrep release asset is mapped for platform "${target}"`);
  }
  return asset;
}

async function fetchOrThrow(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed with status ${response.status}`);
  }
  return response;
}

// jupyterlab-search-replace shells out to `rg`; bundle the official binary
// from GitHub releases so search works without ripgrep on the host PATH.
async function installRipgrep(version, binDir) {
  const asset = ripgrepReleaseAsset(version);
  const baseUrl = `https://github.com/BurntSushi/ripgrep/releases/download/${version}`;
  const tempDir = mkdtempSync(join(tmpdir(), 'xtralab-ripgrep-'));
  try {
    const checksumLine = (
      await (await fetchOrThrow(`${baseUrl}/${asset}.sha256`)).text()
    ).trim();
    const expectedSha = checksumLine.split(/\s+/)[0].toLowerCase();

    const tarballPath = join(tempDir, asset);
    const tarballBytes = Buffer.from(
      await (await fetchOrThrow(`${baseUrl}/${asset}`)).arrayBuffer()
    );
    writeFileSync(tarballPath, tarballBytes);

    const actualSha = createHash('sha256').update(tarballBytes).digest('hex');
    if (actualSha !== expectedSha) {
      throw new Error(
        `ripgrep checksum mismatch for ${asset}: expected ${expectedSha}, got ${actualSha}`
      );
    }

    await run('tar', ['-xzf', tarballPath, '-C', tempDir]);
    const rgSource = join(tempDir, asset.replace(/\.tar\.gz$/, ''), 'rg');
    if (!existsSync(rgSource)) {
      throw new Error(`rg binary not found at ${rgSource} after extracting ${asset}`);
    }

    const rgDest = join(binDir, 'rg');
    copyFileSync(rgSource, rgDest);
    chmodSync(rgDest, 0o755);
    console.log(`Installed ripgrep ${version} (${asset}) at ${rgDest}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

if (!existsSync(requirementsPath)) {
  throw new Error(
    `Bundled requirements.txt not found at ${requirementsPath}. Run "pnpm build:lock" first.`
  );
}

const xtralabWheel = findLatestWheel('xtralab-', 'xtralab');
const desktopWheel = findLatestWheel('xtralab_desktop-', 'xtralab-desktop');
const requirementsBytes = readFileSync(requirementsPath);
const xtralabWheelBytes = readFileSync(xtralabWheel.path);
const desktopWheelBytes = readFileSync(desktopWheel.path);
const fingerprint = {
  schema: markerSchema,
  pythonVersion,
  ripgrepVersion,
  platform: process.platform,
  arch: process.arch,
  requirementsSize: requirementsBytes.byteLength,
  requirementsSha256: createHash('sha256')
    .update(requirementsBytes)
    .digest('hex'),
  xtralabWheelName: xtralabWheel.name,
  xtralabWheelSize: xtralabWheelBytes.byteLength,
  xtralabWheelSha256: createHash('sha256').update(xtralabWheelBytes).digest('hex'),
  desktopWheelName: desktopWheel.name,
  desktopWheelSize: desktopWheelBytes.byteLength,
  desktopWheelSha256: createHash('sha256').update(desktopWheelBytes).digest('hex')
};

const pythonExecutable = join(runtimeDir, 'bin', 'python');
const ripgrepBinary = join(runtimeDir, 'bin', 'rg');
if (
  existsSync(markerPath) &&
  existsSync(pythonExecutable) &&
  existsSync(ripgrepBinary)
) {
  try {
    const previous = JSON.parse(readFileSync(markerPath, 'utf8'));
    if (
      previous.schema === fingerprint.schema &&
      previous.pythonVersion === fingerprint.pythonVersion &&
      previous.ripgrepVersion === fingerprint.ripgrepVersion &&
      previous.platform === fingerprint.platform &&
      previous.arch === fingerprint.arch &&
      previous.requirementsSize === fingerprint.requirementsSize &&
      previous.requirementsSha256 === fingerprint.requirementsSha256 &&
      previous.xtralabWheelName === fingerprint.xtralabWheelName &&
      previous.xtralabWheelSize === fingerprint.xtralabWheelSize &&
      previous.xtralabWheelSha256 === fingerprint.xtralabWheelSha256 &&
      previous.desktopWheelName === fingerprint.desktopWheelName &&
      previous.desktopWheelSize === fingerprint.desktopWheelSize &&
      previous.desktopWheelSha256 === fingerprint.desktopWheelSha256
    ) {
      console.log(
        `Runtime up to date for Python ${pythonVersion} (${xtralabWheel.name} + ${desktopWheel.name}, sha=${fingerprint.requirementsSha256.slice(0, 12)})`
      );
      process.exit(0);
    }
  } catch {
    // Fall through to a full rebuild.
  }
}

console.log(`Building Python runtime at ${runtimeDir}`);
rmSync(runtimeDir, { recursive: true, force: true });
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });

console.log(`Installing Python ${pythonVersion} via uv into staging`);
await run('uv', [
  'python',
  'install',
  '--install-dir',
  stagingDir,
  pythonVersion
]);

const stagingEntries = readdirSync(stagingDir, { withFileTypes: true });
const cpythonReal = stagingEntries.find(entry => {
  if (!entry.name.startsWith('cpython-')) {
    return false;
  }
  return !lstatSync(join(stagingDir, entry.name)).isSymbolicLink();
});
if (cpythonReal === undefined) {
  throw new Error(`Could not find cpython directory under ${stagingDir}`);
}

console.log(`Promoting ${cpythonReal.name} to ${runtimeDir}`);
renameSync(join(stagingDir, cpythonReal.name), runtimeDir);
rmSync(stagingDir, { recursive: true, force: true });

if (!existsSync(pythonExecutable)) {
  throw new Error(`Python executable missing at ${pythonExecutable} after install`);
}

console.log('Installing dependencies into runtime');
await run('uv', [
  'pip',
  'install',
  '--python',
  pythonExecutable,
  '--break-system-packages',
  '--no-index',
  '--find-links',
  wheelsDir,
  '--require-hashes',
  '--only-binary',
  ':all:',
  '-r',
  requirementsPath
]);

console.log(`Installing xtralab wheel ${xtralabWheel.name}`);
await run('uv', [
  'pip',
  'install',
  '--python',
  pythonExecutable,
  '--break-system-packages',
  '--no-deps',
  '--reinstall',
  '--only-binary',
  ':all:',
  xtralabWheel.path
]);

console.log(`Installing xtralab-desktop wheel ${desktopWheel.name}`);
await run('uv', [
  'pip',
  'install',
  '--python',
  pythonExecutable,
  '--break-system-packages',
  '--no-deps',
  '--reinstall',
  '--only-binary',
  ':all:',
  desktopWheel.path
]);

console.log(`Installing ripgrep ${ripgrepVersion}`);
await installRipgrep(ripgrepVersion, join(runtimeDir, 'bin'));

console.log('Rewriting absolute shebangs in bin/');
rewriteRuntimeShebangs(runtimeDir, pythonVersion);

writeFileSync(
  markerPath,
  `${JSON.stringify(fingerprint, null, 2)}\n`,
  'utf8'
);
console.log(`Runtime ready at ${runtimeDir}`);

function rewriteRuntimeShebangs(rootDir, version) {
  const binDir = join(rootDir, 'bin');
  const portableShebang =
    `#!/bin/sh\n` +
    `'''exec' "$(dirname -- "$(realpath -- "$0")")/python${version}" "$0" "$@"\n` +
    `' '''\n`;
  const absolutePrefix = `${rootDir}/`;
  let rewritten = 0;
  for (const entry of readdirSync(binDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const filePath = join(binDir, entry.name);
    let buffer;
    try {
      buffer = readFileSync(filePath);
    } catch {
      continue;
    }
    if (buffer.length < 2 || buffer[0] !== 0x23 || buffer[1] !== 0x21) {
      continue;
    }
    const newlineIndex = buffer.indexOf(0x0a);
    if (newlineIndex === -1) {
      continue;
    }
    const shebang = buffer.subarray(0, newlineIndex).toString('utf8');
    const interpreterPath = shebang.slice(2).trim().split(/\s+/)[0];
    if (!interpreterPath.startsWith(absolutePrefix)) {
      continue;
    }
    const rest = buffer.subarray(newlineIndex + 1);
    const before = statSync(filePath);
    writeFileSync(
      filePath,
      Buffer.concat([Buffer.from(portableShebang, 'utf8'), rest])
    );
    chmodSync(filePath, before.mode);
    rewritten += 1;
  }
  console.log(`Rewrote ${rewritten} script shebang(s) in ${binDir}`);
}
