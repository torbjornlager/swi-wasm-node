'use strict';
// Public session API + real browser Workers, using the published SXML examples.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');

const directory = process.env.STATECHART_EXAMPLES_DIR || path.join(__dirname, '../fixtures/statechart-examples');
const cases = [
  ['13 spawn-actor.xml', ['Received Pong']],
  ['14 spawn-toplevel.xml', ['[q(a)]', '[q(b)]', '[q(c)]', '[q(d)]']],
  ['15 spawn-server.xml', ['reply(1)']],
  ['16 spawn-supervisor.xml', ['[specs-1,active-1,supervisors-0,workers-1]']],
  ['17 spawn-statechart.xml', ['nested(ok)']]
];
const results = [];
function save() {
  if (process.env.STATECHART_REPORT) fs.writeFileSync(process.env.STATECHART_REPORT, JSON.stringify(results, null, 2) + '\n');
}

(async () => {
  const browser = await chromium.launch({executablePath: process.env.CHROME_PATH, headless: true});
  try {
    for (const [file, expected] of cases) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      const result = {file, mode: 'worker'};
      try {
        await page.goto((process.env.RUNTIME_URL || 'http://localhost:8096/') + 'vendor/swi-wasm-minimal.html');
        result.observation = await page.evaluate(async ({xml, expected, active}) => {
          const events = [];
          const node = SwiWasmNode.create({mode: 'worker',
            workerUrl: new URL('../swi_wasm_actor_worker.js', location.href).href,
            engineUrl: new URL('../swipl-bundle.js', location.href).href,
            prologBaseUrl: new URL('../wasm/', location.href).href,
            sharedDatabaseUrl: null, onEvent: event => events.push(event)});
          const atom = text => "'" + text.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
          const require = (condition, message) => {if (!condition) throw Error(message);};
          const output = () => events.filter(e => e.type === 'output').map(e => String(e.data)).join('\n');
          try {
            await node.open();
            const baseline = (await node.query('actors(Actors)')).data[0].Actors;
            const spawned = await node.query('statechart_spawn(Pid,[src_text(' + atom(xml) + ')])');
            require(spawned.type === 'success' && spawned.data[0].Pid, 'startup: ' + JSON.stringify(spawned));
            const pid = spawned.data[0].Pid;
            const deadline = Date.now() + 10000;
            while (!expected.every(text => output().includes(text)) && Date.now() < deadline) {
              await new Promise(resolve => setTimeout(resolve, 25));
            }
            const positions = expected.map(text => output().indexOf(text));
            require(positions.every((position, i) => position >= 0 && (!i || position > positions[i - 1])), 'expected output: ' + output());
            if (active) {
              const halted = await node.query('statechart_halt(' + pid + ',Reply,2)');
              require(halted.type === 'success' && halted.data[0].Reply === 'stopped', 'explicit halt: ' + JSON.stringify(halted));
            }
            let remaining;
            const cleanupDeadline = Date.now() + 5000;
            do {
              remaining = (await node.query('actors(Actors)')).data[0].Actors;
              if (remaining === baseline) break;
              await new Promise(resolve => setTimeout(resolve, 25));
            } while (Date.now() < cleanupDeadline);
            require(remaining === baseline, 'chart or child leaked: ' + remaining);
            require((await node.query('true')).type === 'success', 'session recovers');
            return {pid, expectedOutput: expected, cleanup: true};
          } finally {node.dispose();}
        }, {xml: fs.readFileSync(path.join(directory, file), 'utf8'), expected, active: file.startsWith('13 ')});
        assert.deepEqual(errors, []);
        result.status = 'pass';
      } catch (error) {
        result.status = 'fail';
        result.detail = String(error.stack || error);
      } finally {await page.close();}
      results.push(result); save();
      console.log(file + ': ' + result.status + (result.detail ? '\n' + result.detail : ''));
    }
  } finally {await browser.close();}
  process.exitCode = results.some(result => result.status === 'fail') ? 1 : 0;
})().catch(error => {console.error(error); process.exitCode = 1;});
