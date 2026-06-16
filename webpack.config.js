/**
 * Extra rspack configuration merged into the `@jupyter/builder` labextension
 * build (wired up via `jupyterlab.webpackConfig` in package.json).
 */
module.exports = {
  module: {
    rules: [
      // Emit the `@pierre/diffs` portable worker as a raw asset. The bundler
      // otherwise parses the file referenced from `new URL(...)` in
      // `src/git/diffWorkerPool.tsx` as a regular module, which executes the
      // worker code inside the importing chunk and returns an empty exports
      // object instead of a file URL to hand to `new Worker(...)`.
      {
        test: /@pierre[\\/]diffs[\\/]dist[\\/]worker[\\/]worker-portable\.js$/,
        type: 'asset/resource',
        generator: {
          filename: 'pierre-diffs-worker.[contenthash].js'
        }
      }
    ]
  }
};
