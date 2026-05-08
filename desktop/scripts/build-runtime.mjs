import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
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
const markerSchema = 1;

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

function findXtralabWheel() {
  const candidates = readdirSync(wheelsDir)
    .filter(name => name.startsWith('xtralab-') && name.endsWith('.whl'))
    .map(name => {
      const wheelPath = join(wheelsDir, name);
      return { name, path: wheelPath, mtimeMs: statSync(wheelPath).mtimeMs };
    });
  if (candidates.length === 0) {
    throw new Error(
      `No xtralab wheel found in ${wheelsDir}. Run "npm run build:python" first.`
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

if (!existsSync(requirementsPath)) {
  throw new Error(
    `Bundled requirements.txt not found at ${requirementsPath}. Run "npm run build:lock" first.`
  );
}

const wheel = findXtralabWheel();
const requirementsBytes = readFileSync(requirementsPath);
const wheelBytes = readFileSync(wheel.path);
const fingerprint = {
  schema: markerSchema,
  pythonVersion,
  requirementsSize: requirementsBytes.byteLength,
  requirementsSha256: createHash('sha256')
    .update(requirementsBytes)
    .digest('hex'),
  wheelName: wheel.name,
  wheelSize: wheelBytes.byteLength,
  wheelSha256: createHash('sha256').update(wheelBytes).digest('hex')
};

const pythonExecutable = join(runtimeDir, 'bin', 'python');
if (existsSync(markerPath) && existsSync(pythonExecutable)) {
  try {
    const previous = JSON.parse(readFileSync(markerPath, 'utf8'));
    if (
      previous.schema === fingerprint.schema &&
      previous.pythonVersion === fingerprint.pythonVersion &&
      previous.requirementsSize === fingerprint.requirementsSize &&
      previous.requirementsSha256 === fingerprint.requirementsSha256 &&
      previous.wheelName === fingerprint.wheelName &&
      previous.wheelSize === fingerprint.wheelSize &&
      previous.wheelSha256 === fingerprint.wheelSha256
    ) {
      console.log(
        `Runtime up to date for Python ${pythonVersion} (${wheel.name}, sha=${fingerprint.requirementsSha256.slice(0, 12)})`
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

console.log(`Installing xtralab wheel ${wheel.name}`);
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
  wheel.path
]);

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
