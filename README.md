# SWI-WASM node

A browser Web Prolog runtime powered by SWI-Prolog WASM, extracted from the
[Trinity demonstrator](https://github.com/torbjornlager/trinity-demonstrator).
It provides actors, private query sessions, paging, monitors, statecharts,
HTTP RPC and browser-to-node WebSocket interoperability without a demonstrator UI.

The initial release retains `swipl-wasm@8.2.5` (SWI-Prolog 10.1.19). The application
supplies terminal/editor presentation, input callbacks and any shared database.
The packaged default database is empty; tutorial data is only a test fixture.
The compatibility main engine retains its page-global bridge and DOM access.
The primary convenience session API uses Workers.

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

Load `web/swi_wasm_actor_worker.js` for the compatibility promise store, then
`web/vendor/swi-wasm-node.js`. The latter exports `SwiWasmNode` (also CommonJS).

```javascript
const node = SwiWasmNode.create({
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

The Worker session API is `open`, `query`, `next`, `stop`, `abort`, `input`,
`dispose`. Responses retain the public Prolog answer envelopes. Host callbacks
receive output, traces, logs and lifecycle events. `methods` and `createState`
provide the existing demonstrator's adapter interface. Main compatibility also
exports `initSwiWasmSession`, `loadSwiWasmMainSource`, `driveSwiWasmMainQuery`.
See [runtime details](docs/runtime.md) and [transport contract](docs/browser_actor_transport.md).
The shared language reference remains the demonstrator's Web Prolog manual.

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
