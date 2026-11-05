# Runtime implementation guide

This runtime is UI-independent. Shared knowledge is supplied by the host; the
packaged default database is empty. Historical demonstrator verification links
in the guide refer to the extraction source repository.

# SWI-WASM runtime implementation guide

The [Web Prolog language manual](https://github.com/torbjornlager/trinity-demonstrator/blob/main/web/manual.html) is the shared API reference for
all nodes. This guide records browser implementation details and operational
limitations; it does not define a separate browser language.

## Worker and compatibility main engine

The high-level `SwiWasmNode.create({mode:'worker'|'main', ...})` session API
supports both models. Worker is the default. Main uses the same `open`, `query`,
`next`, `stop`, `abort`, `input` and `dispose` methods and public answer events.
The session host serializes initial statechart preloading, application source
loading and the first query; older compatibility hosts retain background preload.
Main sessions load source once, preserve edits, and use the existing heartbeat
driver with native variable-name capture and Worker-compatible display rows.
Default enumeration is unbounded; `limit` batches lazy pages, `offset` skips
initial solutions, and `once` cuts after the first page. A partial limited page
is delivered before an ordinary exception, which is reported on `next`.
Attributed answers are rejected with `representation_error(constraints)`.

Only one high-level main session can own the page-global bridge at a time.
Disposal rejects pending client work, cancels input and mailbox waits, resets
actors and timers, closes transports and disposes the promise store. Ownership
is held until initialization and active queries finish unwinding, so reopening
cannot race stale bridge installation. Late input completions are ignored.
Initialization failure also releases ownership. Worker sessions may coexist.
Legacy direct `initSwiWasmSession` callers must not initialize a separate main
engine alongside a high-level main session on that page.

The Worker runtime runs each actor in its own Web Worker and SWI-Prolog engine.
The optional main-thread compatibility runtime runs shell queries in a shared
page engine; actors spawned from it still use Workers. Their implementations
live in [swi_wasm_actor_worker.js](../web/swi_wasm_actor_worker.js) and
[vendor/swi-wasm-node.js](../web/vendor/swi-wasm-node.js). The demonstrator supplies
presentation adapters through the host interface; the
[independent minimal host](../web/vendor/swi-wasm-minimal.html) uses the same runtime.
The [extraction inventory and host API](https://github.com/torbjornlager/trinity-demonstrator/blob/bf0d645ba5d906269b1a6b0a77c95d9be73badd6/docs/SWI_WASM_NODE_EXTRACTION.md)
record the repository boundary. Statechart
interpreter sources are under [prolog/web_prolog/wasm](../prolog/web_prolog/wasm/).
The main engine has DOM access and cooperative interruption; Workers can be
terminated by the browser. Neither remains alive after its page is destroyed.

The bundled engine is pinned to `swipl-wasm@8.2.5` (SWI-Prolog 10.1.19), with
package integrity and bundle checksum in `dependencies/swi-wasm.json`.

## Language text and native boundaries

Both browser modes initialise `user:double_quotes` to `chars`. Goals and options,
interactive input, editor/URI source, the isolated `wasm_shared_db` module and
statechart datamodels read double-quoted literals as lists of one-character
Unicode atoms (`"hé😀"` is `[h,é,'😀']`; empty text is `[]`). This is a browser
reading-mode migration, not adoption of the experimental portable-text profile
by every node. `write/1` prints these values as list terms.

Bridge and library modules keep native string reading. Known text inputs (source
and prompt text) convert character lists explicitly at JS/native boundaries;
numeric code lists are rejected. URI and node-address arguments require atoms;
there is no `Host:Port` shorthand. Existing URI origin, CORS and fetch restrictions
remain in force. The shared database is loaded explicitly into its own module,
with bridge imports; it is not copied into user source.

Canonical term messages are still read with `double_quotes(string)`. Native string
objects created by libraries, including returned HTTP data, keep their type and
variable sharing through the wire and Worker startup. Local `src_list/1` and
`src_predicates/1` are already typed terms: their generated source brackets native
string reading and restores character reading afterward. Internally supplied
behaviour code has the same boundary; ordinary user source reads characters.
Explicit remote source retains the destination's existing loading convention and
source ordering. No new remote text-mode negotiation is introduced.

The regression scenarios `portable_text_worker` and `portable_text_main` in
`tests/wasm/swi_wasm_contracts.js` run against the real WASM engine. See
[the migration verification record](../docs/verification/wasm-character-text-2026-10-25/REPORT.md)
for the complete WASM tier and temporary-origin UI checks.

## Main-thread output flushing

The main-thread lazy query driver flushes Prolog's `user_output` and `user_error`
before publishing each answer or exception. Cleanup flushes trailing output on
failure or abandonment. Flush errors do not replace query exceptions, and output
from later alternatives is produced only when the user requests the next answer.
This complements the existing Worker terminal flush; it does not change stream
buffering globally. Regression and UI evidence is in
[the output-flushing record](../docs/verification/wasm-output-flush-2026-10-25/REPORT.md).

## Source loading and named startup

The creating engine asks the page coordinator to fetch supplemental Prolog URI
source before child creation. Fetching retains the URI origin allowlist,
`credentials: same-origin` and CORS restrictions. Both Worker and main engines process
text, lists, copied predicates and URI source in option-list order, for actor
creation and RPC/promise source composition. Repeated URIs cause separate fetches. Failed fetches propagate before
creation. Late completion cannot resume abandoned creation; cancelling an
in-flight fetch is a separate concern.

Wrappers separate their own options and framework metadata before forwarding
spawn options. Name reservations belong to matching creation tokens; explicit
registration and competing creation cannot claim a pending name. The coordinator
records an acknowledged remote pid before resuming the caller, and retains
rollback ownership through publication approval. On setup failure, output
mismatch or interruption it releases the name and withdraws startup-owned
monitors, requesting termination of known remote actors. A late correlated
acknowledgement cannot publish an abandoned creation. Cancellation before socket
readiness prevents late dispatch. Pending records last until acknowledgement
or connection close; remote side effects cannot be undone.

The host's `closeSwiWasmClientContext()` lifecycle hook closes ordinary-name
and promise admission together. It removes ordinary aliases, retires pending
name reservations and rolls back their uncommitted children. Existing actors
and owner service names retain their separate lifetimes. Repeated closure is
harmless; registration, reservation, publication and commit cannot reopen the
closed scope. The promise-only close hook remains available for promise-store
teardown and does not close ordinary names.
New child allocation and deferred remote dispatch also reject a closed context:
source arriving after rollback cannot start a child without a startup owner.

Named creation awaits coordinator confirmation of commit in both modes. If
closure wins before commit, creation reports failure and reclaims its prepared
child. If commit wins, scope closure removes the alias while the committed actor
survives. Session `dispose()` closes admission before interrupting queries and
then performs full actor/transport teardown. The maintained real-Chrome context
closure tests pause real child creation at publication and commit boundaries.
They also hold fetched URI source before child allocation; the source response
is supplied by a browser network fixture, without contacting a public node.

Remote spawn uses `request_id` correlation. Named startup rejects untagged
replies, while unnamed startup retains the legacy FIFO fallback. Reordered
replies settle their own requests; tagged cleanup exits cannot consume another
spawn reply. Remote alias cleanup checks current bindings before removal, then
delivers monitor notifications; old down events cannot remove replacement names.

## Monitor and worker cleanup

Monitor removal during Prolog unwinding cannot await JavaScript promises.
Notifications for a withdrawn reference are filtered until the coordinator
confirms local removal. Only the operation's own monitor is withdrawn. Remote
withdrawal is best effort and does not cancel a server request or collect a late
reply.

Combinators record worker ownership before launch. Normal result collection can
wait for coordinator cleanup; exception unwinding initiates cleanup without
awaiting JavaScript promises. Hard shell Abort closes combinator scopes before
replacing the shell. Ordinary actors outside those scopes survive and are listed
in the survivor notice. Forced Worker termination can bypass Prolog cleanup.

## Supervisors

Startup journals cover initial children, dynamic additions and replacement
groups, including detached and nested local starts. Ownership is tracked before
Worker creation/readiness and monitor setup. Readiness timeout rolls back the
caller's attempt; cleanup exceptions retain the original startup error. Initial
readiness reporting is not reused for later restart failures.

Group restarts preserve original specification records and list positions;
new dynamic children append. Old pid notifications are ignored after replacement.
Counts inspect processed supervisor records, not an independent liveness scan.
Shutdown installs private monitors before stop requests; recognised servers use
a tagged stop acknowledgement, and cleanup removes only that private reply and
monitor. Acknowledgement alone is not a termination barrier.

Browser supervisor halt uses a tagged request and acknowledges after child
shutdown. Its caller deadline remains independent of internal child shutdown
deadlines. Legacy `'$sup_stop'(From)` messages keep their `reply(true)` response.
All runtimes use this completion point. An available matching acknowledgement
has precedence over a down notification, and normal down retains the original
ten-second deadline. Observing supervisor termination requires a separate monitor.

Child IDs are atoms across creation and management APIs. Inspection returns
ordered `info(Id,Pid,Type,Restart)` records, including stopped children. Counts
are `[specs-Specs,active-Active,supervisors-Supervisors,workers-Workers]`, with
only active children included in the type counts. Successful respawn returns
`ok(NewPid)`.

Creation waits for initial child preparation and admission, without waiting for
application goals to finish. Initial failure rolls back and raises
`error(supervisor_start_failed(Pid,Reason),supervisor_spawn/3)`, with `init_failed`
for ordinary failure or the original exception.

## RPC deadlines

`timeout/1` requests destination execution time; `http_timeout/1` bounds each
complete caller HTTP request. Both accept numbers, normalize negatives to zero,
use their first occurrence, and validate every occurrence before source work.
Omission retains the corresponding default. Each later RPC page gets a fresh
HTTP deadline. Source preparation uses its own access policy and deadline.

HTTP expiry raises `error(rpc_error(http_timeout),_)` for RPC. Promises deliver
`error(error(rpc_error(http_timeout),_))` through yield. A zero HTTP deadline
starts no fetch. Remote execution errors retain their original terms. Explicit
Abort remains distinct from transport expiry, and a completed HTTP response is
not timed out during subsequent UI scheduling.

## Promises

A browser runtime instance is one client context. Its coordinator owns a single
promise registry shared by its main engine, shell Workers and spawned actors.
The coordinator binds Worker messages to that instance and actor identity;
query code cannot select another context. Separate runtime instances retain
separate stores, including when their numeric references coincide. Direct
Workers started without a coordinator form their own isolated context.
Isolation is not a security boundary against trusted JavaScript with page access.

Requests run under the context rather than the creating engine. Actor exit and
shell replacement preserve promises in a retained context. Actor interruption
or exit releases only that actor's collector claims. Context disposal retires
all entries, wakes collectors and aborts local transport resources. It does not
guarantee cancellation at the remote node. Issued reference history lasts for
the runtime instance, preventing consumed or expired references from reviving.

Expiry is checked on access and by a timer, so browser timer throttling does not
extend the five-minute validity period. Collector claims are released before
running timeout callbacks. Collection commits before output matching; mismatch
consumes the selected answer. Disposal or expiry winning first produces a
missing-reference error; late completion cannot reinsert an entry.
Worker claims, releases and disposal use the ordered coordinator channel without
suspending Prolog setup or cleanup handlers. Creation, waiting and commit await
coordinator replies. Claim tokens are checked against the sending actor, so late
cleanup cannot release a replacement collector or another actor's claim.

## Statecharts and transport

The compatibility main engine hosts its first chart directly, using the fixed
`statechart` pid, and sends subsequent local charts to Workers. Its dispatch
branches keep local, nested and remote entry points separate so nested creation
does not overwrite the active interpreter configuration. Initial URI XML is fetched by the creating engine before local Worker creation
or remote dispatch. Text and the absolute document URI travel together; the
running chart uses that base for later relative document and Prolog-source
references. Later fetches follow the execution environment's access policy.
Exactly one XML source is required, with missing or multiple sources rejected
before fetching. Supplemental Prolog follows the source-loading path above.

Worker-backed statecharts expose the same `Id@localhost` pid form as ordinary
actors. Their spawn monitors retain that complete pid as the reference. The
main-thread singleton keeps the `statechart` pid; successful startup publishes
its liveness before monitor installation. Its stop boundary retires only that
chart's monitors, delivers normal `down/3` notifications once, and retains normal
completion for a chart that finishes before its spawn monitor is installed.
Main-thread sends and status synchronization use the same retirement boundary;
status checks inspect the WASM query result's `success` field rather than the
truthiness of its result object. Unrelated actor monitors are preserved.

The [native transport implementation notes](https://github.com/torbjornlager/swi-prolog-node/blob/main/prolog/web_prolog/README.md#node-transport-implementation)
document wire envelopes, terminal acknowledgements, session replay and monitor
reference serialization once. Browser connections offer `web-prolog-sync-v1`;
an upgrade failure before opening can retry without a subprotocol for legacy
asynchronous use. A synchronous call checks correlation support both before
monitor setup and on the actual sending socket. Connection setup is outside the
receive timeout.

Clients request `answer_terms:true`; negotiated asynchronous answers are parsed
as complete terms. Main-engine calls request `format(prolog)` to keep explicit
templates, while Worker actor-term calls already retain them. Legacy peers keep
their display-field limitations. The shared manual defines the observable errors
for absent/malformed negotiated terms and unsupported synchronous peers.

## Regression coverage

Browser regression drivers and UI checks cover option/child-spec validation,
source ordering, monitor cleanup, partial worker startup and interruption,
supervisor ordering/rollback/restart/shutdown, engine-local promise ownership,
statechart routing, remote naming, correlation and answer fidelity. Runtime
repair histories belong here and in test descriptions, not in predicate entries.


## Relation to the research agenda

The book’s [research and engineering agenda](https://github.com/torbjornlager/boken/blob/main/author/appendix-research-agenda.tex)
is maintained separately from this runtime guide.

The source-fetch, worker/supervisor cleanup, naming, monitor and promise-store
sections above record SWI-WASM implementation status. Browser-engine coverage,
resource/lifetime guarantees and portable lifecycle contracts remain engineering
and conformance questions, rather than conclusions implied by those repairs.

The shared SXML schema is supplied by the pinned native dependency during
`tools/setup_swi.py`; run browser tests through `tools/test.sh WASM` after setup.

### Common RPC HTTP fields

HTTP fields use `request_header(Name=Value)`, `authorization(basic(User,Password))`,
`authorization(bearer(Token))`, and `user_agent(Agent)`. Names are ASCII HTTP tokens;
values and credential arguments accept atoms, strings and character-list strings.
Every occurrence is validated before source work; the first field with a given
case-insensitive name wins across all option forms. Field values use UTF-8 bytes. Basic credentials use UTF-8
then Base64. RPC fields apply to every page and never to source downloads.
Reserved proxy identity fields are rejected. Caller access policy still applies.

## Runtime capabilities

`runtime_property/1` enumerates only the five language-defined properties.
Worker actors report `actor_isolation(independent)` and the main engine reports
`actor_isolation(cooperative)`. The other values retain their environment
meanings. Unknown properties, including implementation identity, fail normally.
Private engine-mode dispatch preserves naming and statechart startup behavior;
diagnostic tools and package provenance identify the implementation.

`node_setting/2` enumerates the host's available public settings:
`profile(actor)` and `sandbox(off)`. Both execution modes expose the ACTOR API
without a Prolog goal-filtering policy. The sandbox key describes that policy;
browser/WASM confinement and remote-node access policies apply separately.

Unknown, private and unavailable keys fail, including URI, authentication,
timeout, rate and admission-limit settings. Asset URLs, source URLs and remote
RPC destinations are independent of this execution host and supply no node
URL. The host has no configured HTTP admission ceilings to report. Repeated
reads and failed value matches leave the relation unchanged. The predicate is
available in ordinary queries, private helpers, copied child programs, nested
sessions and receive callbacks. The packaged node-setting browser tests check
these contexts in real Chrome with both execution modes.
