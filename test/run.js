'use strict';

/*
 * Test runner.
 *
 * Most of the suite is a single process and just runs. The socket tests are
 * different: they start real servers and wait on real wall-clock timers, so on
 * a loaded machine an occasional wait exceeds its budget and the harness gives
 * up. That is a failure of the test rig, not of the game.
 *
 * So those get exactly one retry, and only for that specific case. A genuine
 * assertion failure is never retried, and never hidden.
 */

const { spawn } = require('child_process');
const path = require('path');

const FILES = [
  'engine.test.js',
  'client.test.js',
  'trade.test.js',
  'bot.test.js',
  'server.test.js',
  'trade.socket.test.js',
  'reconnect.test.js',
  'persist.test.js',
  'deploy.test.js'
];

const MAX_ATTEMPTS = 2;

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, file)], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let out = '';
    child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    child.stderr.on('data', (d) => { out += d; process.stderr.write(d); });

    child.on('close', (code) => resolve({ code: code, output: out }));
  });
}

(async function main() {
  let passedFiles = 0;
  let failedFiles = 0;
  let retriedFiles = 0;
  const failures = [];

  for (const file of FILES) {
    let result = await run(file);
    let attempts = 1;

    // Only a harness timeout is worth a second go.
    while (result.code !== 0 &&
           result.output.includes('FAIL harness error') &&
           attempts < MAX_ATTEMPTS) {
      attempts++;
      retriedFiles++;
      process.stdout.write('\n' + '~'.repeat(60) + '\n');
      process.stdout.write('~ ' + file + ': the harness ran out of time, retrying\n');
      process.stdout.write('~'.repeat(60) + '\n\n');
      result = await run(file);
    }

    if (result.code === 0) {
      passedFiles++;
    } else {
      failedFiles++;
      failures.push(file);
      process.stdout.write('\n' + '='.repeat(60) + '\n');
      process.stdout.write(' FAILED: ' + file + '\n');
      const lines = result.output.split('\n').filter((l) => /\bFAIL\b/.test(l));
      lines.forEach((l) => process.stdout.write('   ' + l.trim() + '\n'));
      process.stdout.write('='.repeat(60) + '\n');
    }
  }

  console.log('\n' + '-'.repeat(60));
  console.log('suites passed : ' + passedFiles + '/' + FILES.length);
  if (retriedFiles) {
    console.log('harness retries : ' + retriedFiles +
      ' (a wait ran out, not an assertion)');
  }
  console.log('-'.repeat(60));

  if (failures.length) {
    console.log('failed: ' + failures.join(', '));
    process.exit(1);
  }
  console.log('All suites passed.');
})();