// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:3333',
    headless: true,
  },
  webServer: {
    command: 'npx serve . -l 3333 --no-clipboard',
    port: 3333,
    reuseExistingServer: true,
  },
});
