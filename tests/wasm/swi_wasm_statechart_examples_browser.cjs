'use strict';
// Public session API + real browser Workers, using the published SXML examples.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');

const directory = process.env.STATECHART_EXAMPLES_DIR || path.join(__dirname, '../fixtures/statechart-examples');
const cases = [
  ['08 closure.xml', ['Closure: [p(a,b),p(b,c),p(c,d),p(a,c),p(b,d),p(a,d)]']],
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
        result.observation = await page.evaluate(async ({xml, expected, active, fileIsClosure}) => {
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
            if (fileIsClosure) {
              require(events.filter(e => e.type === 'output' && String(e.data) === expected[0]).length === 1,
                'closure output must arrive exactly once: ' + output());
              const outputIndex = events.findIndex(e => e.type === 'output' && String(e.data) === expected[0]);
              const answerIndex = events.findIndex(e => e.type === 'answer' && e.message &&
                e.message.type === 'success' && e.message.data[0].Pid === pid);
              require(outputIndex < answerIndex, 'closure output must precede the spawn answer');
              const boundaries = '<statechart version="0.2" initial="s"><state id="s">' +
                '<onentry>format("startup fragment",[])</onentry>' +
                '<go on="more">format("event fragment",[])</go>' +
                '<go on="finish" to="f">format("final fragment",[])</go>' +
                '</state><final id="f"/></statechart>';
              const next = await node.query('statechart_spawn(Next,[src_text(' + atom(boundaries) + ')])');
              require(next.type === 'success', 'boundary startup: ' + JSON.stringify(next));
              const nextPid = next.data[0].Next;
              async function requireFragment(text) {
                const until = Date.now() + 5000;
                while (!events.some(e => e.type === 'output' && String(e.data) === text) && Date.now() < until) {
                  await new Promise(resolve => setTimeout(resolve, 25));
                }
                require(events.filter(e => e.type === 'output' && String(e.data) === text).length === 1,
                  'missing or repeated boundary output ' + text + ': ' + output());
              }
              await requireFragment('startup fragment');
              require((await node.query('send(' + nextPid + ',more)')).type === 'success', 'send more');
              await requireFragment('event fragment');
              require((await node.query('send(' + nextPid + ',finish)')).type === 'success', 'send finish');
              await requireFragment('final fragment');
            }
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
        }, {xml: fs.readFileSync(path.join(directory, file), 'utf8'), expected,
            active: file.startsWith('13 '), fileIsClosure: file.startsWith('08 ')});
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
