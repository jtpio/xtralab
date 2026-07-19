const path = require('path');
const baseConfig = require('@jupyterlab/galata/lib/playwright-config');

module.exports = {
  ...baseConfig,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    ...baseConfig.use,
    baseURL: 'http://localhost:8899',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    trace: 'off',
    video: 'off'
  },
  webServer: {
    command:
      'node seed-workspace.mjs && uv run --no-sync jupyter lab --config jupyter_server_test_config.py',
    url: 'http://localhost:8899/lab',
    timeout: 240 * 1000,
    reuseExistingServer: false,
    env: {
      // Root the server at the seeded project so the file browser and git
      // integration see it, and keep user-level Jupyter config out of the
      // run (and settings writes out of the real user config).
      JUPYTERLAB_GALATA_ROOT_DIR: path.join(
        __dirname,
        'workspace',
        'demo-project'
      ),
      JUPYTER_CONFIG_DIR: path.join(__dirname, 'workspace', 'jupyter-config')
    }
  }
};
