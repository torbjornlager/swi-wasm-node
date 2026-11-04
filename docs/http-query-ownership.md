# HTTP RPC query ownership

The RPC bridge attaches `X-Web-Prolog-Query-Owner` to `/call` requests in Worker,
main-thread, promise and compatibility transports. A capability contains 32 bytes
from Web Crypto's cryptographic random generator, encoded as 64 lowercase hex
characters. Pages to the same destination origin retain the capability, including
when third-party cookies are unavailable. Different origins get different values.
The per-page registry is bounded to 256 origins; eviction causes a fresh identity.
Source fetches do not receive the header. Capabilities are kept out of URLs.

This identifies an anonymous browser RPC visitor; it does not authenticate a user
or grant execution permissions. Use HTTPS and treat the header as a bearer secret.
The receiving node must enforce ownership. CORS deployments must allow this header
in OPTIONS responses. Peers that ignore unknown headers continue to work.

`tests/wasm/http_query_owner.cjs` checks entropy/format, page stability, destination
separation, source-fetch exclusion and the bounded registry. The package runner
also runs the real-engine Worker, standalone and semantic-contract tests.
