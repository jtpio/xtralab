import * as React from 'react';

import { WorkerPoolContextProvider, useWorkerPool } from '@pierre/diffs/react';

import { resolveDiffTheme } from './diffTheme';

/**
 * URL of the syntax-highlighting worker, emitted as a raw asset via
 * `new URL(..., import.meta.url)` so it resolves under federated loading.
 * Addressed as a file path because the package's `worker` subpath export is
 * `import`-only, which rspack's URL resolver does not apply.
 */
const WORKER_URL = new URL(
  '../../node_modules/@pierre/diffs/dist/worker/worker-portable.js',
  import.meta.url
);

/**
 * A diff tab highlights one file at a time, so a small pool suffices
 * (the library defaults to eight workers).
 */
const POOL_SIZE = 2;

/**
 * Mounts the process-wide `@pierre/diffs` worker pool: `FileDiff`s below it
 * paint as plain text and swap highlights in as worker results arrive, with
 * a main-thread fallback if the workers fail to boot.
 */
export function DiffWorkerPoolProvider(props: {
  dark: boolean;
  pierreTheme: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const { dark, pierreTheme, children } = props;
  return (
    <WorkerPoolContextProvider
      poolOptions={{
        workerFactory: () => new Worker(WORKER_URL),
        poolSize: POOL_SIZE
      }}
      highlighterOptions={{ theme: resolveDiffTheme(dark, pierreTheme) }}
    >
      <PoolThemeSync dark={dark} pierreTheme={pierreTheme} />
      {children}
    </WorkerPoolContextProvider>
  );
}

/**
 * Keeps the pool's render options on the active JupyterLab theme: while a
 * pool exists, token colors come from the pool-wide options rather than
 * per-component `options.theme`. `setRenderOptions` no-ops when unchanged.
 */
function PoolThemeSync(props: { dark: boolean; pierreTheme: boolean }): null {
  const { dark, pierreTheme } = props;
  const pool = useWorkerPool();
  React.useEffect(() => {
    if (pool === undefined) {
      return;
    }
    pool
      .setRenderOptions({ theme: resolveDiffTheme(dark, pierreTheme) })
      .catch(err => {
        console.error('xtralab: failed to update diff worker theme', err);
      });
  }, [pool, dark, pierreTheme]);
  return null;
}
