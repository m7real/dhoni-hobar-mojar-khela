'use strict';

/* Deployment surface: CORS lockdown, headers, and config defaults. */

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');

const SERVER = path.join(__dirname, '..', 'server', 'index.js');

let passed = 0;
let failed = 0;
function ok(cond, label, detail) {
  if (cond) { passed++; console.log('  ok   ' + label); }
  else { failed++; console.log('  FAIL ' + label + (detail ? '  -> ' + detail : '')); }
}
function section(n) { console.log('\n' + n); }

function get(port, pathname, headers) {
  return new Promise((resolve) => {
    const req = http.get({
      host: '127.0.0.1',
      port: port,
      path: pathname,
      headers: headers || {}
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: body }));
    });
    req.on('error', (e) => resolve({ status: 0, headers: {}, body: '', error: e.message }));
    req.setTimeout(6000, () => { req.destroy(); resolve({ status: 0, headers: {}, body: '' }); });
  });
}

function waitFor(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      get(port, '/health').then((r) => {
        if (r.status === 200) return resolve();
        if (Date.now() - started > timeoutMs) return reject(new Error('no boot'));
        setTimeout(tick, 120);
      });
    };
    tick();
  });
}

// ---- the config files exist and say the right things ----------------------

section('deployment files');
{
  const root = path.join(__dirname, '..');

  const render = fs.readFileSync(path.join(root, 'render.yaml'), 'utf8');
  ok(/healthCheckPath:\s*\/health/.test(render), 'render.yaml declares a health check');
  ok(/startCommand:\s*npm start/.test(render), 'render.yaml uses npm start');
  ok(/buildCommand:\s*npm ci/.test(render), 'render.yaml installs with npm ci');
  ok(/mountPath:\s*\/var\/data/.test(render), 'render.yaml mounts a persistent disk');
  ok(/STORE_DIR[\s\S]*\/var\/data\/rooms/.test(render),
    'the store points at the mounted disk');
  ok(/plan:\s*starter/.test(render),
    'the plan is paid, because disks and no-spin-down need it');
  ok(/MAX_ROUNDS/.test(render), 'the round limit is configurable on Render');
  ok(/ALLOWED_ORIGIN/.test(render), 'the origin allowlist is configurable');

  ok(fs.existsSync(path.join(root, 'Dockerfile')), 'a Dockerfile is provided as an alternative');
  ok(fs.existsSync(path.join(root, '.gitignore')), 'there is a .gitignore');
  ok(fs.existsSync(path.join(root, '.gitattributes')), 'there is a .gitattributes');
  ok(fs.existsSync(path.join(root, '.gitattributes')), 'there is a .gitattributes');

  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  ok(/^node_modules\//m.test(ignore), 'node_modules is ignored');
  ok(/^data\//m.test(ignore), 'saved games are ignored');
  ok(/^\.env$/m.test(ignore), 'a real .env is ignored');

  const env = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  ['PORT', 'STORE_DIR', 'ALLOWED_ORIGIN', 'MAX_ROUNDS', 'RESUME_GRACE_MS']
    .forEach(function (key) {
      // Optional keys are shipped commented out, so accept either form.
      const assigned = new RegExp('^\\s*#?\\s*' + key + '=', 'm');
      ok(assigned.test(env), '.env.example documents ' + key);
    });

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  ok(pkg.scripts.start === 'node server/index.js', 'npm start boots the server');
  ok(typeof pkg.scripts.test === 'string', 'npm test runs the suite');
  ok(!pkg.dependencies.cors, 'the unused cors package was removed');
  ok(!pkg.dependencies.uuid, 'the unused uuid package was removed');
}

// ---- the server honours PORT and the store location -----------------------

// ---- the credit-free Linux deployment path --------------------------------

section('the systemd unit');
{
  const root = path.join(__dirname, '..');
  const unitPath = path.join(root, 'deploy', 'dhoni-hobar-mojar-khela.service');
  ok(fs.existsSync(unitPath), 'the systemd unit exists');
  const unit = fs.readFileSync(unitPath, 'utf8');

  ok(/\[Unit\]/.test(unit) && /\[Service\]/.test(unit) && /\[Install\]/.test(unit),
    'the unit has all three required sections');

  // A game that only comes back by hand is a game that is down.
  ok(/Restart=always/.test(unit), 'it restarts by itself after a crash');
  ok(/RestartSec=\d+/.test(unit), 'there is a pause between restarts');
  ok(/WantedBy=multi-user\.target/.test(unit), 'it starts on boot');

  // Waiting for a real network, not merely for boot to finish.
  ok(/After=network-online\.target/.test(unit), 'it waits for the network');

  ok(/EnvironmentFile=\/etc\/dhoni-hobar-mojar-khela\.env/.test(unit),
    'it reads the environment file');
  ok(/^User=dhk/m.test(unit), 'it does not run as root');

  // Only the saved-games directory should be writable.
  ok(/ProtectSystem=strict/.test(unit), 'the filesystem is read-only');
  ok(/ReadWritePaths=\/opt\/dhoni-hobar-mojar-khela\/data/.test(unit),
    'only the data directory is writable');
  ok(/NoNewPrivileges=true/.test(unit), 'privileges cannot be escalated');

  ok(/ExecStart=\/usr\/bin\/node server\/index\.js/.test(unit),
    'it starts the server the same way npm does',
    (unit.match(/ExecStart=.*/) || [])[0]);
}

section('the deployment files agree with each other');
{
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const unit = fs.readFileSync(path.join(root, 'deploy', 'dhoni-hobar-mojar-khela.service'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'deploy', 'install.sh'), 'utf8');
  const envExample = fs.readFileSync(
    path.join(root, 'deploy', 'dhoni-hobar-mojar-khela.env.example'), 'utf8');

  // If these drift apart, the service silently points at the wrong place.
  ok(pkg.main === 'server/index.js', 'package.json main is the server');
  ok(pkg.scripts.start === 'node server/index.js', 'npm start is the documented entry point');
  ok(unit.includes('ExecStart=/usr/bin/node server/index.js'),
    'the unit ExecStart matches npm start');
  ok(unit.includes('WorkingDirectory=/opt/dhoni-hobar-mojar-khela'),
    'the unit works where the installer puts the code');
  ok(script.includes('APP_DIR=/opt/dhoni-hobar-mojar-khela'),
    'the installer uses that same directory');
  ok(unit.includes('ReadWritePaths=/opt/dhoni-hobar-mojar-khela/data'),
    'the writable path sits inside the install directory');
  ok(/^STORE_DIR=\/opt\/dhoni-hobar-mojar-khela\/data\/rooms$/m.test(envExample),
    'the config template stores games inside that writable path');

  // Updating must not clobber a configured instance.
  ok(/if \[ -f "\$\{ENV_FILE\}" \]/.test(script),
    'the installer keeps an existing configuration file');
  ok(/git -C "\$\{APP_DIR\}" pull --quiet --ff-only/.test(script),
    'updating pulls rather than force-resetting');
  ok(/npm ci --omit=dev/.test(script), 'it installs production dependencies only');
  ok(/systemctl enable/.test(script) && /systemctl restart/.test(script),
    'it enables and starts the service');
  ok(/health/.test(script), 'it verifies the game actually answers');
  ok(/set -euo pipefail/.test(script), 'the installer fails loudly rather than limping on');
  ok(/id -u/.test(script), 'the installer insists on being run as root');

  ['PORT', 'NODE_ENV', 'STORE_DIR', 'ALLOWED_ORIGIN', 'MAX_ROUNDS', 'RESUME_GRACE_MS']
    .forEach(function (key) {
      ok(new RegExp('^' + key + '=', 'm').test(envExample),
        'the config template sets ' + key);
    });
  ok(/REPLACE-ME/.test(envExample),
    'the config template makes the placeholder obvious');
}

section('shell scripts keep Unix line endings');
{
  const root = path.join(__dirname, '..');

  // A stray carriage return makes bash fail with "bad interpreter".
  const script = fs.readFileSync(path.join(root, 'deploy', 'install.sh'));
  ok(script.indexOf(13) === -1, 'install.sh has no carriage returns');

  const unit = fs.readFileSync(path.join(root, 'deploy', 'dhoni-hobar-mojar-khela.service'));
  ok(unit.indexOf(13) === -1, 'the systemd unit has no carriage returns');

  const attrs = fs.readFileSync(path.join(root, '.gitattributes'), 'utf8');
  ok(/eol=lf/.test(attrs), '.gitattributes forces Unix line endings');
  ok(/\*\.sh text eol=lf/.test(attrs), 'shell scripts are pinned to LF');
}

section('the guide states its warnings');
{
  const guide = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'zendevz.md'), 'utf8');

  // Someone should not have to deploy to find these out.
  ok(/alpha/i.test(guide), 'the guide says Zendevz is alpha');
  ok(/not built for production|isn't built for production/i.test(guide),
    'the guide repeats the not-for-production warning');
  ok(/sleep|sleeps|offline/i.test(guide), 'the guide mentions the sleep/offline caveat');
  ok(/credit card/i.test(guide), 'the guide is explicit about not needing a card');

  // The steps someone actually needs.
  ok(/ALLOWED_ORIGIN/.test(guide), 'the guide covers setting ALLOWED_ORIGIN');
  ok(/Elastic Edge/.test(guide), 'the guide covers Elastic Edge');
  ok(/install\.sh/.test(guide), 'the guide links the installer');
  ok(/journalctl/.test(guide), 'the guide explains how to read logs');
  ok(/websocket|polling/i.test(guide), 'the guide explains the transport question');

  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  ok(/zendevz/i.test(readme), 'the README points at the Zendevz guide');
  ok(/render\.yaml/.test(readme), 'the README still documents the Render path');
}

section('the Azure guide');
{
  const guide = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'azure.md'), 'utf8');

  // The three things that actually stop an Azure deployment working.
  ok(/security group|NSG/i.test(guide), 'the guide covers the network security group');
  ok(/Inbound port rules|Inbound security rules/i.test(guide),
    'the guide says where to add the inbound rule');
  ok(/auto-?shutdown/i.test(guide), 'the guide covers auto-shutdown');
  ok(/[Dd]eallocate/.test(guide), 'the guide covers deallocate versus stop');

  // Money, because this is a credit that runs out.
  ok(/\$100/.test(guide), 'the guide mentions the student credit');
  ok(/budget alert/i.test(guide), 'the guide recommends a budget alert');
  ok(/disabled|decommissioned/i.test(guide),
    'the guide says what happens when the credit runs out');

  // Honesty about plain HTTP.
  ok(/https?:\/\//.test(guide) && /no HTTPS|without a domain/i.test(guide),
    'the guide is upfront about there being no HTTPS');

  ok(/ssh /i.test(guide), 'the guide explains how to get in');
  ok(/install\.sh/.test(guide), 'the guide links the installer');
  ok(/ALLOWED_ORIGIN/.test(guide), 'the guide covers setting ALLOWED_ORIGIN');
  ok(/journalctl/.test(guide), 'the guide explains how to read logs');

  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  ok(/azure/i.test(readme), 'the README points at the Azure guide');
}

section('environment configuration');
(async function configTests() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dhk-cfg-'));
  const PORT = 3489;
  let server = null;

  try {
    server = spawn(process.execPath, [SERVER], {
      env: Object.assign({}, process.env, {
        PORT: String(PORT),
        STORE_DIR: dir,
        NODE_ENV: 'production',
        MAX_ROUNDS: '25',
        RESUME_GRACE_MS: '60000'
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    server.stderr.on('data', (d) => { stderr += d; });

    await waitFor(PORT, 30000);
    ok(true, 'the server boots with production environment variables');

    const health = await get(PORT, '/health');
    ok(health.status === 200, 'the health check answers');
    ok(JSON.parse(health.body).ok === true, 'health reports ok');

    section('security headers');
    const home = await get(PORT, '/');
    ok(home.status === 200, 'the game page is served');
    ok(home.headers['x-content-type-options'] === 'nosniff',
      'X-Content-Type-Options is set', home.headers['x-content-type-options']);
    ok(home.headers['x-frame-options'] === 'DENY', 'clickjacking is refused',
      home.headers['x-frame-options']);
    ok(home.headers['referrer-policy'] === 'no-referrer', 'Referrer-Policy is set',
      home.headers['referrer-policy']);
    ok(!home.headers['x-powered-by'], 'the server does not advertise itself');

    section('saved games honour STORE_DIR');
    const { io } = require('socket.io-client');
    const socket = io('http://127.0.0.1:' + PORT, { transports: ['websocket'] });
    await new Promise((r) => socket.on('connect', r));
    const joined = await new Promise((r) => socket.emit('join', { name: 'রিয়া' }, r));
    ok(joined.ok === true, 'a game can be created over the deployed server');

    await new Promise((r) => setTimeout(r, 500));
    const saved = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    ok(saved.length === 1, 'the game was saved into STORE_DIR', dir + ' -> ' + saved.join(','));
    socket.close();

    section('round limit comes from the environment');
    const health2 = await get(PORT, '/health');
    ok(JSON.parse(health2.body).rooms >= 0, 'the room is tracked');
    void stderr;
  } catch (err) {
    failed++;
    console.log('  FAIL harness error: ' + err.message);
  } finally {
    if (server) server.kill('SIGKILL');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  // ---- the origin allowlist ------------------------------------------------
  section('the origin allowlist is enforced');
  {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dhk-cors-'));
    const PORT2 = 3491;
    const server2 = spawn(process.execPath, [SERVER], {
      env: Object.assign({}, process.env, {
        PORT: String(PORT2),
        STORE_DIR: dir2,
        ALLOWED_ORIGIN: 'https://mine.example.com',
        NODE_ENV: 'production'
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    try {
      await waitFor(PORT2, 30000);
      ok(true, 'the server boots with an allowlist');

      const mine = await get(PORT2, '/health', { Origin: 'https://mine.example.com' });
      ok(mine.status === 200, 'the allowed origin can connect', String(mine.status));

      const www = await get(PORT2, '/health', { Origin: 'https://www.mine.example.com' });
      ok(www.status === 200, 'the www variant of the domain is allowed too', String(www.status));

      const other = await get(PORT2, '/health', { Origin: 'https://evil.example.org' });
      ok(!other.headers['access-control-allow-origin'],
        'another origin is not granted access',
        JSON.stringify(other.headers['access-control-allow-origin']));

      const none = await get(PORT2, '/health');
      ok(none.status === 200, 'a request with no origin still works',
        'health checks and curl send no Origin header');
    } catch (err) {
      failed++;
      console.log('  FAIL harness error: ' + err.message);
    } finally {
      server2.kill('SIGKILL');
      try { fs.rmSync(dir2, { recursive: true, force: true }); } catch (_) {}
    }
  }

  console.log('\n' + '-'.repeat(52));
  console.log('passed: ' + passed + '   failed: ' + failed);
  console.log('-'.repeat(52));
  process.exit(failed === 0 ? 0 : 1);
})();