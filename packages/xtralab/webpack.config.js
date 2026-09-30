/**
 * Extra rspack configuration merged into the `@jupyter/builder` labextension
 * build (wired up via `jupyterlab.webpackConfig` in package.json).
 */
module.exports = {
  module: {
    rules: [
      // Emit the `@pierre/diffs` portable worker as a raw asset; the bundler
      // otherwise parses the `new URL(...)` reference in diffWorkerPool.tsx
      // as a module and yields no file URL for `new Worker(...)`.
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
