# SWI-WASM node

A browser Web Prolog runtime powered by SWI-Prolog WASM, extracted from the
[Trinity demonstrator](https://github.com/torbjornlager/trinity-demonstrator).
It provides actors, private query sessions, paging, monitors, statecharts,
HTTP RPC and browser-to-node WebSocket interoperability without a demonstrator UI.

The initial release retains `swipl-wasm@8.2.5` (SWI-Prolog 10.1.19). The application
supplies terminal/editor presentation, input callbacks and any shared database.
The packaged default database is empty; tutorial data is only a test fixture.
The session API supports Worker execution (the default) and main-thread
execution with DOM access. The main engine retains its page-global bridge.

`node_setting/2` reports the available browser-host settings, `profile(actor)`
and `sandbox(off)`. Unknown or unavailable keys fail. URI, authentication and
HTTP admission settings are unavailable in these execution hosts. See the
[runtime reference](docs/runtime.md#runtime-capabilities) for the distinction
between goal policy, browser confinement and remote-node policy.

## Build and test

```sh
python3 tools/package_runtime.py --output /fresh/package
python3 /fresh/package/tools/test.py --package /fresh/package --report /fresh/results
python3 /fresh/package/tools/serve.py --package /fresh/package --prefix /release/0.1
```

Use the test runner: it supplies a temporary test database and runs real-engine
mailbox, standalone-host and semantic-contract tests. No demonstrator checkout,
native Prolog process, or npm installation is needed. Node.js 22+ and Python 3.9+
are required. Pass `--swipl /verified/swipl` to run the 60 additional Prolog
statechart unit/spawn cases. Pass `--native-root /exact/swi-prolog-node` and
`--swipl` to include upstream equivalence and native serialization integration.
Without those inputs, that external integration is explicitly not selected.

Builds require a clean source checkout. `--allow-dirty` creates a clearly marked
development package that consumers must not pin as a release. `--archive FILE`
writes a deterministic tar.gz; `--verify DIRECTORY` verifies an existing package.
The manifest records the exact runtime source revision, engine, schema input
and SHA-256 for every packaged file. The package is tested directly, not through
source-directory fallback. `web/` is a complete static distribution and may be
served by an ordinary static server at its root; the supplied server can also
exercise a prefixed deployment. No Prolog server is required for browser execution.

## Host API

Load `web/swi_wasm_actor_worker.js` for the shared client-context promise registry, then
`web/vendor/swi-wasm-node.js`. The latter exports `SwiWasmNode` (also CommonJS).

```javascript
const node = SwiWasmNode.create({
  mode: 'worker', // Use 'main' for the UI-thread engine with library(dom).
  workerUrl: '/swi_wasm_actor_worker.js',
  engineUrl: '/swipl-bundle.js',
  prologBaseUrl: '/wasm/',
  sharedDatabaseUrl: null,
  onEvent(event) { if (event.type === 'output') console.log(event.data); },
  onInput(text) { return window.prompt(text); }
});
await node.open({source: 'square(X,Y) :- Y is X*X.'});
console.log(await node.query('square(3,Y)', {limit: 1}));
node.dispose();
```

Both modes use `open`, `query`, `next`, `stop`, `abort`, `input`, `dispose`.
Responses retain the public Prolog answer envelopes and formatted binding rows.
`query` accepts `{limit, offset, once}` or equivalent Prolog options text.
Without `limit`, it collects all answers; a positive limit gives lazy pages.
`once:true` returns only the first page. `open` is idempotent, preserving edits;
use a new session for a different source program. Host callbacks
receive output, traces, logs and lifecycle events. `methods` and `createState`
provide the existing demonstrator's adapter interface. Main compatibility also
exports `initSwiWasmSession`, `loadSwiWasmMainSource`, `driveSwiWasmMainQuery`.
See [runtime details](docs/runtime.md) and [transport contract](docs/browser_actor_transport.md).
The shared language reference remains the demonstrator's Web Prolog manual.

Worker sessions are independent. A page can have one open main-thread session
alongside any Worker sessions. A second main session is rejected; after disposal,
a replacement's `open` waits for the old engine's startup/query work to unwind.
Do not mix a high-level main session with a separate legacy compatibility engine
on the same page. Main-thread Abort is cooperative: a call that cannot yield
also blocks the interface. Worker execution retains hard interruption/isolation.
Main-thread syntax errors return an error envelope and leave the session usable;
the existing Worker syntax-error path may require `open` to replace its shell.

The optional real-browser session suite checks both modes through the public API:

```sh
NODE_PATH=/path/to/node_modules python3 /fresh/package/tools/test.py \
  --package /fresh/package --report /fresh/browser-results \
  --browser-executable /path/to/chrome
```

This additionally requires Playwright on Node's module path and an installed
Chromium/Chrome browser. The runner supplies a loopback static server and checks
DOM access, common paging/options, actor/statechart use, input, Abort, cleanup,
startup failure, and main-session ownership. Core tests keep their existing
Node/Python-only dependencies when this option is omitted.

Statechart examples 13–17 also run in the default semantic-contract suite with
real WASM engines and child Workers. The optional browser suite repeats their
observable behaviour and cleanup through the public session API. Vendored,
unmodified example documents live in `tests/fixtures/statechart-examples`;
`STATECHART_EXAMPLES_DIR` can select the demonstrator's current example directory
for an integration run.

The browser suite also runs the unmodified `08 closure.xml`. It requires all six
computed edges to appear exactly once before the spawn answer, including when
`format/2` has no newline. Dedicated statechart Workers publish pending output
after their initial macrostep and before waiting for another event. This keeps
startup text from being erased by the actor loop's output-buffer reset and makes
partial output visible while a chart is idle. The regression also checks partial
startup, event and final output plus actor cleanup.

## Source, schema and licensing

Runtime code and tests originate from demonstrator revision
`bf0d645ba5d906269b1a6b0a77c95d9be73badd6`; [EXTRACTION.json](EXTRACTION.json)
records ownership and the scenario partition. Seven presenter cases and the
live tutorial assertion remain in the demonstrator. Test SXML/database fixtures
are frozen test data, not application examples or runtime default knowledge.

The native repository remains authoritative for the SXML schema. Its checksummed
build input is vendored under `third_party/` so builds and CI do not require
access to that private repository. `dependencies/native-schema.json` records its
exact revision, schema hash and normalized shared-algorithm hashes. Update these
inputs only by verifying the matching upstream checkout; an explicit native-root
build compares bytes against that checkout's Git object. This is a pinned input,
not a separately maintained schema implementation.

Our runtime is MIT licensed. SWI-Prolog's bundled copyright/redistribution terms
are retained in [third_party/LICENSE.txt](third_party/LICENSE.txt), copied from the
integrity-verified npm tarball. The engine package, source commit and integrity
are pinned in `dependencies/swi-wasm.json`.


The development runtime supplies Appendix B's `maplist/6-8` and `countall/2`
in both execution modes and their spawned actors, without explicit user imports.
Private-source callbacks keep their calling module. The real-browser library
regression runs the mirrored shared fixture in `tests/fixtures/standard-library.json`
and a copied-source child control. It is included when `tools/test.py` selects
`--browser-executable`; an external shared fixture may be supplied using
`LIBRARY_MANIFEST`. Development packages require `--allow-dirty` and must not be
used as release pins.

Library callbacks validate callable values when invoked. Uninstantiated values
raise `instantiation_error`; invalid values raise `type_error(callable, Value)`
with the original culprit. Empty iteration and vacuous `forall` tests leave unused
callbacks alone, and application exceptions propagate unchanged. ISO `call/N`
keeps the underlying runtime's existing error contract. The shared fixture
includes exact callback errors for every required `maplist` and `foldl` arity.
