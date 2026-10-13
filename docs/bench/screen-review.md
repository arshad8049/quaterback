# Screen task review sheet (QB-30 harder candidates)

Generated from `bench/screen/curation/*/task.json`. **All 14 tasks are qualified with the real grader:** the upstream fix passes, and both plausible wrong implementations fail on tests.

For each task, check three things before approving the freeze:
- the **prompt**, which is all the agent sees;
- the **acceptance criteria**, the oracle you approve;
- that the prompt states everything the criteria check.

The hidden suites are in `bench/screen/suites/<ID>/`.

## FY-01 — bug_fix · fastify-5.8.4

**Prompt (what the agent sees):** request.port returns a wrong number when the Host header has no port: for the IPv6 host '[::1]' it returns 1, and for '127.0.0.1' it returns 127, where it should return null. Fix the request.port getter so that it returns the port, as a number, only when the Host header (or, when there is no Host header, the HTTP/2 ':authority' header) ends with ':' followed by digits, and null otherwise. For example: 'example.com:80' gives 80, 'example.com:443' gives 443, '[::1]:80' gives 80, '[::1]' gives null, '127.0.0.1' gives null, 'example.com' gives null, 'localhost:3000' gives 3000, an ':authority' of '1.2.3.4:80' with no Host header gives 80, and no Host or ':authority' header gives null.

**Acceptance criteria:**
- AC-1: a Host with a trailing port returns that port as a number: 'example.com:80' gives 80, 'localhost:3000' gives 3000, '[::1]:443' gives 443
- AC-2: a Host without a port returns null, including '[::1]', '127.0.0.1' and 'example.com'
- AC-3: with no Host header the ':authority' header is used ('1.2.3.4:80' gives 80); with neither header the port is null

**Wrong implementations (each fails):** second-segment, unanchored-regex

**Provenance:** Real defect in fastify v5.8.4 (port parses the last ':'-segment), fixed upstream in 39f0f242 'Fix port parsing (#6603)'. The reference is that fix applied to v5.8.4. The hidden suite is the upstream test plus IPv4/hostname-without-port cases the prompt states.

## FY-02 — bug_fix · fastify-5.8.4

**Prompt (what the agent sees):** With trustProxy set to a number (a hop count), request.ip is undefined when the socket's remoteAddress is undefined or null (as happens behind IISNode on Windows). Fix it so a missing socket address still counts as the first hop: with trustProxy: 1, an X-Forwarded-For of '2.2.2.2, 1.1.1.1' and socket.remoteAddress undefined, request.ip must be '1.1.1.1'; the same with socket.remoteAddress null. With socket.remoteAddress undefined and an X-Forwarded-Host of 'fastify.test', request.host must be 'fastify.test'.

**Acceptance criteria:**
- AC-1: trustProxy: 1, socket.remoteAddress undefined, X-Forwarded-For '2.2.2.2, 1.1.1.1': request.ip is '1.1.1.1'
- AC-2: the same with socket.remoteAddress null: request.ip is '1.1.1.1'
- AC-3: trustProxy: 1, socket.remoteAddress undefined, X-Forwarded-Host 'fastify.test': request.host is 'fastify.test'

**Wrong implementations (each fails):** null-only-guard, trust-every-hop

**Provenance:** Real defect in fastify v5.8.4 (the hop-count trust function rejects a null/undefined address), fixed upstream in 8dee9be0 (#6613, issue #6606). The reference is that fix applied to v5.8.4; the hidden suite is the upstream tests.

## FY-03 — bug_fix · fastify-5.8.2

**Prompt (what the agent sees):** Security: with trustProxy enabled, request.host, request.hostname and request.protocol read X-Forwarded-Host and X-Forwarded-Proto even when the connection does not come from a trusted proxy, so a client connecting directly can spoof them. Make these getters use the forwarded headers only when the connection's own socket address (the first hop) is trusted by the trustProxy setting; otherwise request.host and request.hostname must come from the Host header and request.protocol from the socket ('https' when the socket is encrypted, else 'http'). Whether the connection is trusted depends only on the socket address, not on whether an X-Forwarded-For header is present: a trusted proxy that sends X-Forwarded-Host and X-Forwarded-Proto without X-Forwarded-For must still have them honoured. trustProxy: true keeps trusting every connection.

**Acceptance criteria:**
- AC-1: an untrusted connection (trustProxy '10.0.0.1', socket 127.0.0.1) ignores X-Forwarded-Host/Proto: host is the Host header, hostname its name, protocol 'http'
- AC-2: a trusted connection (trust function accepting 127.0.0.1) uses X-Forwarded-Host and X-Forwarded-Proto, with or without an X-Forwarded-For header
- AC-3: trustProxy: true trusts every connection: X-Forwarded-Host is used

**Wrong implementations (each fails):** ip-heuristic, protocol-only

**Provenance:** Real security defect in fastify v5.8.2 (GHSA-444r-cwp2-x5xf), fixed upstream in 4e1db5bd. The reference is that fix applied to v5.8.2. The hidden suite tests the request object directly (no listening server) and adds the trusted-without-X-Forwarded-For case the prompt states.

## FY-04 — errors · fastify-5.8.5

**Prompt (what the agent sees):** A route registered with an invalid logLevel (for example fastify.get('/log', { logLevel: 'invalid' }, handler) on a Fastify instance created with logger: true) is accepted silently. Validate the route's logLevel when the route is registered: if it is not one of the logger's levels, or is not a string, registration must throw a new Fastify error FST_ERR_ROUTE_LOG_LEVEL_INVALID, exported with the other error codes in lib/errors.js. It is a TypeError with statusCode 500 and the message template "Log level for '%s:%s' route must be a valid logger level. Received: '%s'" (method, url, the received value), so the example throws "Log level for 'GET:/log' route must be a valid logger level. Received: 'invalid'". A null logLevel is treated as omitted (no error), and valid levels such as 'debug' are accepted. Adding the error code changes the error count checked in test/internals/errors.test.js; update that expected count.

**Acceptance criteria:**
- AC-1: lib/errors.js exports FST_ERR_ROUTE_LOG_LEVEL_INVALID: a TypeError with code 'FST_ERR_ROUTE_LOG_LEVEL_INVALID', statusCode 500 and the message template "Log level for '%s:%s' route must be a valid logger level. Received: '%s'"
- AC-2: with logger: true, registering GET /log with logLevel 'invalid' throws it with the message "Log level for 'GET:/log' route must be a valid logger level. Received: 'invalid'"; a non-string logLevel also throws it
- AC-3: logLevel null, and a valid level such as 'debug', register normally and the route responds
- AC-4: the expected error count in test/internals/errors.test.js is updated for the new code

**Wrong implementations (each fails):** type-check-only, wrong-message

**Provenance:** Real gap in fastify v5.8.5 (an invalid route logLevel is accepted), fixed upstream in 2ae3e1d7 (#6523). The reference is that fix applied to v5.8.5, plus the upstream update of the error count. The hidden suite follows the upstream tests and adds the non-string and valid-level cases the prompt states.

## FY-05 — addition · fastify-5.11.0

**Prompt (what the agent sees):** fastify.addHttpMethod silently overrides a method that already exists, such as addHttpMethod('GET', { hasBody: true }). Deprecate implicit overrides: addHttpMethod accepts a new option overrideExisting (default false). When the method already exists (as a method with or without a body) and overrideExisting is not true, emit a new Fastify deprecation warning FSTDEP025 (defined with the other warnings in lib/warnings.js, name 'FastifyDeprecation', code 'FSTDEP025', message 'Calling addHttpMethod for existing method "%s" without { overrideExisting: true } is deprecated. In Fastify v6, this will throw an error.' with the method name), every time this happens, not only the first time. With { overrideExisting: true } no warning is emitted, and adding a method that does not exist yet emits no warning. The override itself still takes effect in both cases (for example, GET then accepts a body).

**Acceptance criteria:**
- AC-1: addHttpMethod('GET', { hasBody: true }) emits a warning named 'FastifyDeprecation' with code 'FSTDEP025' and message 'Calling addHttpMethod for existing method "GET" without { overrideExisting: true } is deprecated. In Fastify v6, this will throw an error.'
- AC-2: the warning is emitted on every such call, not only the first
- AC-3: { overrideExisting: true } emits no warning, and adding a method that does not exist yet emits no warning
- AC-4: with { hasBody: true, overrideExisting: true }, a GET route with a body schema receives and returns the JSON body

**Wrong implementations (each fails):** warn-even-when-explicit, warns-once

**Provenance:** Real gap in fastify v5.11.0 (addHttpMethod overrides silently), changed upstream in 0e9a3b35 (#6879). The reference is that change applied to v5.11.0 (runtime only; docs and types not graded). The hidden suite follows the upstream tests and adds the every-time and new-method cases the prompt states.

## FY-06 — state · fastify-5.11.2

**Prompt (what the agent sees):** When every trailer registered on a reply is removed with reply.removeTrailer() before the reply is sent, Fastify still switches the response to trailer mode: it sends Transfer-Encoding: chunked and an empty Trailer header, and drops Content-Length. Fix it so that a reply whose trailers have all been removed behaves exactly as if no trailer had been registered: no Trailer header, no Transfer-Encoding: chunked, a normal Content-Length (5 for the body 'hello'), and no trailer function is called. Removing only some trailers must keep trailer mode for the remaining ones: for example, registering ETag and Content-MD5, removing ETag and sending 'hello' must give a Trailer header of 'content-md5', Transfer-Encoding: chunked, no Content-Length, and the content-md5 trailer value; the removed ETag function is never called.

**Acceptance criteria:**
- AC-1: register an ETag trailer, remove it, send 'hello': status 200, no Trailer header, no Transfer-Encoding, Content-Length '5', no etag trailer, the ETag function never called
- AC-2: register ETag and Content-MD5, remove ETag, send 'hello': Trailer 'content-md5', Transfer-Encoding 'chunked', no Content-Length, trailer content-md5 'custom-md5'; the ETag function never called

**Wrong implementations (each fails):** headers-only-guard, remove-clears-all

**Provenance:** Real defect in fastify v5.11.2 (removing all trailers still forces chunked trailer mode), fixed upstream in 7299a57d (#6845). The reference is that fix applied to v5.11.2; the hidden suite is the upstream remove-all and remove-some tests.

## FY-07 — bug_fix · fastify-5.11.3

**Prompt (what the agent sees):** reply.removeHeader(name) only removes the header from Fastify's own header store. A header set directly on the Node response (reply.raw.setHeader('X-Foo', 'raw')) is still visible through reply.getHeader/getHeaders/hasHeader after removeHeader, and is still sent to the client. Fix reply.removeHeader so that, matching the name case-insensitively, it also removes the header from the underlying response, whether the header was set only on reply.raw or on both reply.raw and through reply.header(). After removal, getHeader returns undefined, getHeaders() has no such key, hasHeader is false and the client receives no such header. removeHeader keeps returning the reply, and must not throw when the headers have already been sent (for example after reply.hijack() and reply.raw.flushHeaders()); in that case the header already sent stays as it was.

**Acceptance criteria:**
- AC-1: a header set only with reply.raw.setHeader('X-Foo', 'raw') and removed with removeHeader('x-FoO') is gone from getHeader, getHeaders and hasHeader, and the client receives no x-foo header
- AC-2: a header set on reply.raw and then with reply.header('x-foo', 'fastify') is fully removed by removeHeader('x-foo')
- AC-3: removeHeader returns the reply; after reply.hijack() and reply.raw.flushHeaders() it does not throw and the client still receives the raw header

**Wrong implementations (each fails):** no-headers-sent-guard, only-if-fastify-set

**Provenance:** Real defect in fastify v5.11.3 (removeHeader leaves raw response headers), fixed upstream in b9e54023 (#6860/#6939). The reference is that fix applied to v5.11.3; the hidden suite is the upstream tests (loopback server and fetch).

## FY-08 — bug_fix · fastify-5.12.0

**Prompt (what the agent sees):** When a route's schema for a request part is a root primitive, Fastify validates the coerced value but the handler still receives the original one. For example, with schema.body { type: 'integer', minimum: 1, maximum: 10 } and the JSON body "10" (a string), validation passes but request.body is still the string '10'. Fix validation so that a value Ajv coerces at the root of a request part is assigned to the request, for every primitive type: the example must give request.body === 10 (a number), and a body schema { type: 'boolean' } with the JSON body "true" must give request.body === true. Validation must still reject invalid values with a 400 (the JSON body "0" against the integer schema above). Routes using a custom validatorCompiler, whose validators are plain functions rather than Ajv validators, must keep working as before.

**Acceptance criteria:**
- AC-1: body schema { type: 'integer', minimum: 1, maximum: 10 } with JSON body "10": status 200 and request.body is the number 10
- AC-2: body schema { type: 'boolean' } with JSON body "true": request.body is the boolean true
- AC-3: JSON body "0" against the integer schema is rejected with 400
- AC-4: a route with a custom validatorCompiler returning a plain validator function still validates and responds

**Wrong implementations (each fails):** numeric-only-coercion, reassign-original

**Provenance:** Real defect in fastify v5.12.0 (root-primitive coercion is lost), fixed upstream in 1ef8a60c. The reference is that fix applied to v5.12.0. The hidden suite extends the upstream test with the boolean, invalid and custom-validator cases the prompt states.

## FY-09 — bug_fix · fastify-5.12.1

**Prompt (what the agent sees):** Security: with an async request schema (an Ajv schema with $async: true), Fastify treats the validated data as if it were a custom-compiler result of the shape { value, error }. A client can therefore send a body containing a 'value' key to replace the whole request body with it, or an 'error' key to make a valid request fail. Fix validation so that the result an async validator resolves with only decides pass or fail: for a body schema { $async: true, type: 'object', additionalProperties: true, properties: { hello: { type: 'string' } } }, the body { hello: 'world', value: { hello: 'evil' } } must reach the handler unchanged, the body { hello: 'world', error: 'boom' } must succeed with status 200 and reach the handler unchanged, and an invalid body such as { hello: { not: 'a string' } } must still be rejected with 400. The synchronous custom-compiler contract is unchanged: a custom validatorCompiler whose validator returns { value: x } still replaces the request part with x, and one that returns { error } still fails with 400.

**Acceptance criteria:**
- AC-1: with the $async body schema, { hello: 'world', value: { hello: 'evil' } } returns 200 and the handler sees exactly that body
- AC-2: with the $async body schema, { hello: 'world', error: 'boom' } returns 200 and the handler sees exactly that body
- AC-3: with the $async body schema, { hello: { not: 'a string' } } is rejected with 400
- AC-4: a synchronous custom validatorCompiler returning { value: x } replaces the body with x; returning { error } fails with 400

**Wrong implementations (each fails):** async-keeps-error, never-unwrap-value

**Provenance:** Real security defect in fastify v5.12.1 (GHSA-667r-xxjv-c9mm: async validator results unwrapped as { value, error }), fixed upstream in f02d8d4a. The reference is that fix applied to v5.12.1. The hidden suite is the upstream tests plus the invalid-async and synchronous-contract cases the prompt states.

## FY-10 — errors · fastify-5.6.1

**Prompt (what the agent sees):** A custom validator (from a route's validatorCompiler) that throws synchronously, instead of returning { error }, is not handled consistently: when an async preValidation hook is registered, the throw becomes an unhandled promise rejection and the route's error handler is never called. Make a synchronous throw from a validator behave the same with sync and async preValidation hooks: the thrown error itself (same message, e.g. 'Custom validation failed') must reach the error handler set with setErrorHandler, as an internal error with error.statusCode === 500 (not a 400 validation error). Without a custom error handler, the response is Fastify's default 500 response carrying the thrown error's message.

**Acceptance criteria:**
- AC-1: with an async preValidation hook, a validator that throws Error('Custom validation failed') makes setErrorHandler receive that error, with statusCode 500, and the route responds 500
- AC-2: the same with a sync (callback) preValidation hook
- AC-3: without a custom error handler the response is status 500 with message 'Custom validation failed'

**Wrong implementations (each fails):** caught-as-validation-error, generic-error

**Provenance:** Real defect in fastify v5.6.1 (a throwing custom validator with an async preValidation hook becomes an unhandled rejection; issue #6214), fixed upstream in d338dca5 (#6247). The reference is that fix applied to v5.6.1. The hidden suite is the upstream tests plus the statusCode and default-handler cases the prompt states.

## FY-11 — bug_fix · fastify-5.10.0

**Prompt (what the agent sees):** Fastify's Content-Type parser (the ContentType class in lib/content-type.js) mishandles quoted parameter values (RFC 9110 quoted-string): a ';' inside quotes ends the value early, a 'key=value' inside a quoted value leaks out as a separate parameter, and backslash escapes are not unescaped. Fix it so a parameter value may be a token or a full quoted-string, and inside a quoted-string ';', '=' and escaped quotes are part of the value. For a quoted value, remove the surrounding double quotes and replace every backslash-escaped character (\x) by the character itself. Examples: 'application/json; name="foo;bar"; charset=utf-8' is valid, with media type 'application/json', parameter name 'foo;bar' and charset 'utf-8'; 'application/json; name="a=b;charset=fake"; boundary=xyz' is valid with name 'a=b;charset=fake', boundary 'xyz' and no charset parameter; 'application/json; name="he said \"hi\""' is valid with name 'he said "hi"'; 'application/json; charset="utf-8"; foo="BaR"' still gives charset 'utf-8' and foo 'BaR' (case preserved). Because reply.send relies on this parser to see whether a charset is already declared, a reply with Content-Type 'application/json; name="a=b;charset=fake"' sending { hello: 'world' } must be sent with Content-Type 'application/json; name="a=b;charset=fake"; charset=utf-8'.

**Acceptance criteria:**
- AC-1: 'application/json; name="foo;bar"; charset=utf-8' is valid with mediaType 'application/json', name 'foo;bar' and charset 'utf-8'
- AC-2: 'application/json; name="a=b;charset=fake"; boundary=xyz' is valid with name 'a=b;charset=fake', boundary 'xyz' and no charset parameter
- AC-3: a quoted-pair is unescaped: name="he said \"hi\"" gives 'he said "hi"'
- AC-4: 'application/json; charset="utf-8"; foo="BaR"' gives charset 'utf-8' and foo 'BaR'
- AC-5: reply.send with Content-Type 'application/json; name="a=b;charset=fake"' sends 'application/json; name="a=b;charset=fake"; charset=utf-8'

**Wrong implementations (each fails):** no-unescape, strip-quotes-only

**Provenance:** Real defect in fastify v5.10.0 (quoted-string parameter values split on ';' and not unescaped), fixed upstream in 29bdcbb9 (#6865). The reference is that fix applied to v5.10.0; the hidden suite is the upstream tests plus the preserved quoted-value case.

## FY-12 — bug_fix · fastify-5.9.0

**Prompt (what the agent sees):** reply.send decides whether a custom Content-Type is JSON, and whether it already declares a charset, with case-sensitive substring searches on the raw header string. As a result: 'application/json; CHARSET=utf-8' gets a second '; charset=utf-8' appended; 'ApPlIcAtIoN/JsOn; ChArSeT=utf-8' is not recognised as JSON, so sending an object fails with a 500; and 'application/json; x-charset-hint=a' (a parameter whose name only contains 'charset') gets no charset at all. Fix reply.send so it parses the Content-Type header with Fastify's ContentType parser (lib/content-type.js): JSON is detected from the parsed media type, case-insensitively (any media type containing 'json', such as application/vnd.api+json), and a charset is considered declared only when there is a parameter named charset, compared case-insensitively. When a JSON media type has no charset parameter, '; charset=utf-8' is appended to the header. Expected results when sending { hello: 'world' }: 'application/json; CHARSET=utf-8' and 'ApPlIcAtIoN/JsOn; ChArSeT=utf-8' are sent unchanged with status 200 and the JSON body; 'application/json; version="2"' becomes 'application/json; version="2"; charset=utf-8'; 'application/vnd.api+json' becomes 'application/vnd.api+json; charset=utf-8'; 'application/json;' becomes 'application/json; charset=utf-8'; for 'application/json; x-charset-hint=a' the header keeps the x-charset-hint parameter and ends with '; charset=utf-8'.

**Acceptance criteria:**
- AC-1: 'application/json; CHARSET=utf-8' is sent unchanged (no second charset)
- AC-2: 'ApPlIcAtIoN/JsOn; ChArSeT=utf-8' is treated as JSON: status 200, JSON body, header unchanged
- AC-3: 'application/json; version="2"' becomes 'application/json; version="2"; charset=utf-8'; 'application/vnd.api+json' gets '; charset=utf-8'; 'application/json;' becomes 'application/json; charset=utf-8'
- AC-4: 'application/json; x-charset-hint=a' keeps the x-charset-hint parameter and ends with '; charset=utf-8'

**Wrong implementations (each fails):** charset-regex-only, lowercase-substring

**Provenance:** Real defect in fastify v5.9.0 (case-sensitive substring JSON/charset detection in reply.send), fixed upstream in 6f63ce93 (#6830), which spans 5 files (a shared ContentType cache). Behaviour probed on base and reference before writing. The hidden suite grades reply.send behaviour only, not the internal cache API; it does not require a specific re-serialisation of parameter quoting.

## FY-13 — bug_fix · fastify-5.8.5

**Prompt (what the agent sees):** Response schemas declared per content type (schema.response[status].content['application/json'].schema) are silently skipped when the reply's Content-Type has whitespace before the parameters, for example 'application/json ; charset=utf-8', 'application/json\t; charset=utf-8' or 'application/json ;'. The reply is then serialised without the schema, so fields the schema would remove (a schema with additionalProperties: false) leak to the client. Fix the response schema lookup so it uses the media type parsed from the Content-Type with Fastify's ContentType parser (lib/content-type.js), so that any whitespace (spaces or tabs) around the media type is ignored, for every kind of response schema: an exact status code (200), and the 'default' response. Example: with the 200 schema { type: 'object', additionalProperties: false, properties: { public: { type: 'string' } }, required: ['public'] } under 'application/json', sending { public: 'ok', secret: 'SHOULD_BE_STRIPPED' } must return 200 with the body { public: 'ok' } for each of those Content-Type values; the same holds when that schema is declared under the 'default' response instead of 200.

**Acceptance criteria:**
- AC-1: with Content-Type 'application/json ; charset=utf-8', the 200 'application/json' schema applies: { public: 'ok', secret: 'SHOULD_BE_STRIPPED' } is sent as { public: 'ok' }
- AC-2: the same for 'application/json\t; charset=utf-8' and 'application/json ;'
- AC-3: a schema declared under the 'default' response is applied the same way for 'application/json ; charset=utf-8'

**Wrong implementations (each fails):** exact-status-only, spaces-only-trim

**Provenance:** Real defect in fastify v5.8.5 (response schema lookup by raw text before ';', so whitespace skips the schema and leaks fields), fixed upstream in c06fc06d (#6685). The reference is that fix applied to v5.8.5. The hidden suite is the upstream whitespace, tab and trailing-semicolon tests plus the 'default' case the prompt states. Upper-case media types are out of scope at this base: reply.send rejects them before the lookup (fixed later upstream, see FY-12).

## FY-14 — errors · fastify-5.10.0

**Prompt (what the agent sees):** When an async onSend or preSerialization hook sets an invalid header value, for example reply.header('X-Invalid', '\n'), Node throws while writing the response head, but the error escapes Fastify: the request never gets a response, the onError hooks are not called, and the error surfaces as an uncaught exception. Fix this so that such an error goes through Fastify's normal error handling: the request must be answered with status 500, whose JSON body has code 'ERR_INVALID_CHAR' (the Node error code), the onError hook must be called, and no exception or promise rejection may escape uncaught. Do not drop or sanitise the invalid header instead: the request must end with that 500 error. This applies to an async onSend hook (async (request, reply, payload) => { reply.header('X-Invalid', '\n'); return payload }) and to an async preSerialization hook (async (request, reply) => { reply.header('X-Invalid', '\n') }) on a route returning { ok: true }.

**Acceptance criteria:**
- AC-1: an async onSend hook setting reply.header('X-Invalid', '\n') makes the request respond with status 500 and JSON code 'ERR_INVALID_CHAR'
- AC-2: the same for an async preSerialization hook
- AC-3: in both cases the onError hook is called, and no uncaught exception or unhandled rejection occurs

**Wrong implementations (each fails):** drop-invalid-header, swallow-error

**Provenance:** Real defect in fastify v5.10.0 (a writeHead throw after an async onSend/preSerialization hook escapes: no response, uncaught), fixed upstream in 01ca8393 (#6881). Probed: base gives no response and 1 uncaught error; reference gives 500 ERR_INVALID_CHAR, onError called, 0 uncaught. The hidden suite grades what the client gets (with its own timer, so a hang fails an assertion), plus onError and no uncaught errors.

