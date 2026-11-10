const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 120_000,
  use: {
    baseURL: 'http://localhost:8000',
    trace: 'off'
  },
  webServer: {
    command: 'python3 -m http.server 8000 --directory dist',
    port: 8000,
    reuseExistingServer: false
  }
});
