import * as React from 'react';

import { WorkerPoolContextProvider, useWorkerPool } from '@pierre/diffs/react';

import { resolveDiffTheme } from './diffTheme';

/**
 * URL of the syntax-highlighting worker. The standalone `new URL(...,
 * import.meta.url)` form makes the bundler emit the file as a raw asset and
 * resolve it against the bundle's public path at runtime, which holds up
 * under JupyterLab's federated extension loading. `worker-portable.js` is
 * the library's self-contained worker build (no imports), so the raw file
 * boots as-is from the labextension's static directory.
 *
 * The file is addressed relative to the compiled module (`lib/git/`) rather
 * than as `@pierre/diffs/worker/worker-portable.js` because the package
 * exposes that subpath export only under the `import` condition, which
 * rspack's URL-dependency resolver in `@jupyter/builder` does not apply —
 * a plain file path sidesteps the exports map.
 */
const WORKER_URL = new URL(
  '../../node_modules/@pierre/diffs/dist/worker/worker-portable.js',
  import.meta.url
);

/**
 * Number of pooled workers. A diff tab highlights one file at a time (or a
 * notebook's handful of cell sub-diffs), so a small pool keeps tokenization
 * off the UI thread without idling most of the library's default of eight.
 */
const POOL_SIZE = 2;

/**
 * Mount the `@pierre/diffs` worker pool for a diff view. The library keeps
 * one pool process-wide: the first provider creates it (seeding its options)
 * and the last one to unmount terminates it. `FileDiff`s below the provider
 * hand tokenization and intra-line diffing to the workers, paint immediately
 * as plain text, and swap highlights in as results arrive; if the workers
 * fail to boot, the library falls back to its main-thread highlighter.
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
 * Keep the pool's render options on the active JupyterLab theme. While a
 * working pool exists, token colors come from the pool-wide options rather
 * than per-component `options.theme`, so a theme switch must go through
 * `setRenderOptions` (which re-renders subscribed diffs). The call no-ops
 * when the options already match, so several mounted diff views syncing the
 * same theme do not thrash the workers.
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
