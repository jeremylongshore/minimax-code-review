'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync, readdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

test('committed bundle boots and refuses a non-PR event without network or private-home writes', () => {
  const home = mkdtempSync(join(tmpdir(), 'review-bundle-smoke-'));
  try {
    const script = `
      let attempts = 0;
      const refuse = () => { attempts++; throw new Error('Synthetic network refusal'); };
      globalThis.fetch = refuse;
      for (const name of ['node:http', 'node:https']) {
        const module = require(name); module.request = refuse; module.get = refuse;
      }
      const net = require('node:net');
      net.connect = net.createConnection = net.Socket.prototype.connect = refuse;
      process.on('exit', () => { if (attempts) process.exitCode = 99; });
      require(process.argv[1]);
    `;
    const result = spawnSync(process.execPath, ['-e', script, resolve(__dirname, '../dist/index.js')], {
      env: {
        HOME: home,
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REPOSITORY: 'synthetic-owner/synthetic-repo',
        INPUT_MINIMAX_API_KEY: 'synthetic-bundle-key',
        INPUT_GITHUB_TOKEN: 'synthetic-bundle-github-token',
      },
      encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /This action only works on pull_request events/);
    assert(!result.stdout.includes('"component":"provider"'));
    assert.deepEqual(readdirSync(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
