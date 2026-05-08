import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, '..');
const wheelsDir = join(desktopRoot, 'python', 'wheels');
const requirementsPath = join(wheelsDir, 'requirements.txt');
const markerPath = join(wheelsDir, '.wheelhouse-state.json');
const pythonVersion = process.env.XTRALAB_PYTHON ?? '3.13';
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

mkdirSync(wheelsDir, { recursive: true });

const requirementsBytes = readFileSync(requirementsPath);
const fingerprint = {
  schema: markerSchema,
  pythonVersion,
  requirementsSize: requirementsBytes.byteLength,
  requirementsSha256: createHash('sha256')
    .update(requirementsBytes)
    .digest('hex')
};

if (existsSync(markerPath)) {
  try {
    const previous = JSON.parse(readFileSync(markerPath, 'utf8'));
    const wheelCount = readdirSync(wheelsDir).filter(name =>
      name.endsWith('.whl')
    ).length;
    if (
      wheelCount > 0 &&
      previous.schema === fingerprint.schema &&
      previous.pythonVersion === fingerprint.pythonVersion &&
      previous.requirementsSize === fingerprint.requirementsSize &&
      previous.requirementsSha256 === fingerprint.requirementsSha256
    ) {
      console.log(
        `Wheelhouse up to date for Python ${pythonVersion} (${wheelCount} wheels, sha=${fingerprint.requirementsSha256.slice(0, 12)})`
      );
      process.exit(0);
    }
  } catch {
    // Fall through to a full rebuild.
  }
}

console.log(`Cleaning .whl files from ${wheelsDir}`);
for (const name of readdirSync(wheelsDir)) {
  if (name.endsWith('.whl')) {
    unlinkSync(join(wheelsDir, name));
  }
}

const tempBase = mkdtempSync(join(tmpdir(), 'xtralab-wheelhouse-'));
const tempVenv = join(tempBase, 'env');

try {
  console.log(`Bootstrapping pip in ${tempVenv} with Python ${pythonVersion}`);
  await run('uv', ['venv', '--seed', '--python', pythonVersion, tempVenv]);

  const pipPath =
    process.platform === 'win32'
      ? join(tempVenv, 'Scripts', 'pip.exe')
      : join(tempVenv, 'bin', 'pip');

  console.log(`Downloading wheels into ${wheelsDir}`);
  await run(pipPath, [
    'download',
    '--no-deps',
    '--require-hashes',
    '--only-binary',
    ':all:',
    '-r',
    requirementsPath,
    '--dest',
    wheelsDir
  ]);
} finally {
  rmSync(tempBase, { recursive: true, force: true });
}

const wheelCount = readdirSync(wheelsDir).filter(name =>
  name.endsWith('.whl')
).length;

writeFileSync(
  markerPath,
  `${JSON.stringify(fingerprint, null, 2)}\n`,
  'utf8'
);

console.log(`Wheelhouse populated with ${wheelCount} wheels at ${wheelsDir}`);
