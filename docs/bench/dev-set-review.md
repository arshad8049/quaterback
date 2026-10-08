# Dev-set review sheet (KAN-62)

Generated from `bench/curation/*/task.json` and `bench/suites/*`. For each task: the prompt (the only text arms A and B see), the acceptance criteria (the contract arms C–F run from), the hidden tests, and the incorrect implementations the suite must reject.

**For the approver:** check that every hidden test is determined by the prompt, and that the criteria say the same thing. Then run `node bench/curate.js freeze <ID|all> --approver "<your name>"`. Freeze refuses any task edited after qualification.

## AV-01 — bug_fix (avvio)

**Prompt:** The plugin time tree attaches children to the wrong node when two plugins share a name. In lib/time-tree.js, start two nodes with the same label under root, stop the FIRST one, then start a child whose parent is that label: the child is attached to the stopped node instead of the one still running. Fix it: stop(id) must stop exactly the node with that id, and start(parentLabel, …) must attach the child to the most recently started node with that label that is still running. Stopping an id that doesn't exist does nothing.

**Acceptance criteria:**

- AC-1: with two running nodes labelled 'p', stopping the first and then starting a child of 'p' attaches the child to the second
- AC-2: stopping the second instead attaches the child to the first
- AC-3: with both running, a child of 'p' goes under the most recently started one
- AC-4: stopping an unknown id changes nothing: a child still goes under the most recent 'p'
- AC-5: single-node behaviour is unchanged

**Hidden tests:**

- stop the first same-label node: a child goes under the second
- stop the second same-label node: a child goes under the first
- with both running, a child goes under the most recently started
- stopping an unknown id is a no-op
- a single node still works

**Reference:** reference/. **Incorrect (must fail):** drop-label, shift-first

## AV-02 — state (avvio)

**Prompt:** app.toJSON() (and TimeTree#toJSON) hand out the live plugin tree: a caller that edits the returned object (e.g. relabels a node or pushes into nodes) changes what later toJSON() and prettyPrint() report. Return a copy the caller can't use to change the internal state at any depth, with the same data as before. An empty tree still returns {}.

**Acceptance criteria:**

- AC-1: the returned tree has the same structure, labels and timings
- AC-2: pushing into or editing the returned nodes at any depth does not change a later toJSON() or prettyPrint()
- AC-3: TimeTree#toJSON on its own has the same guarantee
- AC-4: an empty TimeTree's toJSON() returns {}

**Hidden tests:**

- same data
- TimeTree: editing a nested node does not leak
- TimeTree: pushing at the top level does not leak
- app.toJSON: nested edits do not change prettyPrint
- an empty tree gives {}

**Reference:** reference/. **Incorrect (must fail):** boot-only, one-level

## AV-03 — addition (avvio)

**Prompt:** Add app.hasPlugin(name): it should return true or false for whether a plugin with that name has been registered with this avvio instance with use(), directly or nested inside another plugin, as soon as use() has been called (before or after ready). The name is the one avvio already gives a plugin: its fastify-plugin metadata name, the name option passed to use(), or the function's name.

**Acceptance criteria:**

- AC-1: after use(function foo …) and ready, app.hasPlugin('foo') === true
- AC-2: nested plugins registered inside another plugin are found
- AC-3: a name given through options.name is found
- AC-4: unknown names return false

**Hidden tests:**

- a registered plugin is found after ready
- it is found as soon as it is registered
- nested plugins are found
- options.name is used
- unknown names are false
- it returns booleans

**Reference:** reference/. **Incorrect (must fail):** function-name-only, top-level-only

## AV-04 — errors (avvio)

**Prompt:** app.after('not a function') is accepted silently and the app later fails to boot with 'func.apply is not a function'. Reject a non-function callback up front, the same way ready() and onClose() do: after(value) with a value that is not a function throws synchronously the existing AVV_ERR_CALLBACK_NOT_FN error for the 'after' hook, naming typeof value (message "Callback for 'after' hook is not a function. Received: '<typeof>'"). after() with no argument still returns a promise, and function callbacks are unchanged.

**Acceptance criteria:**

- AC-1: after('x') throws synchronously with code AVV_ERR_CALLBACK_NOT_FN and message "Callback for 'after' hook is not a function. Received: 'string'"
- AC-2: after(42) reports 'number'
- AC-3: after() with no argument still returns a promise that resolves
- AC-4: after(fn) still runs fn

**Hidden tests:**

- after('x') throws synchronously
- after(42) names the type
- after({}) names the type
- after() still returns a promise
- after(fn) still runs fn

**Reference:** reference/. **Incorrect (must fail):** deferred-error, generic-error

## AV-05 — already_satisfied (avvio)

**Prompt:** app.use([]) should fail immediately with avvio's invalid-plugin error (AVV_ERR_PLUGIN_NOT_VALID, "Plugin must be a function or a promise. Received: '<kind>'") and say that it received an array (not 'object'), so people passing an array of plugins understand the mistake. Other values keep their current reporting (null as 'null', other values by typeof), and functions and promises are still accepted.

**Acceptance criteria:**

- AC-1: use([]) throws AVV_ERR_PLUGIN_NOT_VALID with message "Plugin must be a function or a promise. Received: 'array'"
- AC-2: use(null) names 'null'; use(42) names 'number'
- AC-3: functions and promises are still accepted

**Hidden tests:**

- an array is reported as array
- an array of plugins is reported as array
- null is reported as null
- a number is reported as number
- functions and promises are still accepted

**Reference:** none (already satisfied: the correct change is no change). **Incorrect (must fail):** accept-arrays, typeof-only

## AV-06 — refactor (avvio)

**Prompt:** Refactor: move the tree pretty-printer (prettyPrintTimeTree) out of lib/time-tree.js into its own module lib/pretty-print.js, exported as a named function, and have TimeTree use it. Output must not change.

**Acceptance criteria:**

- AC-1: require('lib/pretty-print').prettyPrintTimeTree(tree.toJSON()) equals tree.prettyPrint() and the known output for a nested tree
- AC-2: TimeTree#prettyPrint renders through lib/pretty-print (replacing that module changes its output)
- AC-3: lib/time-tree.js no longer defines its own prettyPrintTimeTree (as a declaration, function expression or arrow function)
- AC-4: app.prettyPrint() output is unchanged

**Hidden tests:**

- the new module renders the known output
- TimeTree#prettyPrint is unchanged
- TimeTree renders through lib/pretty-print
- time-tree.js no longer defines its own copy
- app.prettyPrint still works

**Reference:** reference/. **Incorrect (must fail):** arrow-copy-kept, copy-kept, default-export, drops-branch-marker

## FJ-01 — state (fast-json-stringify)

**Prompt:** Serializer options leak between builds: after building one serializer with { largeArraySize: 2, largeArrayMechanism: 'json-stringify' }, a serializer built later WITHOUT options still uses JSON.stringify for arrays (so integer items like 1.5 come out unrounded). Each build should use only its own options: an option a build doesn't set takes the library default (mechanism 'default', size 20000), whatever earlier builds used, and serializers already built keep the behaviour they were built with.

**Acceptance criteria:**

- AC-1: a build with no options after a json-stringify build rounds integer array items ([1.5, 2.5] → [1,2])
- AC-2: a build that sets only largeArrayMechanism uses the default size 20000, not an earlier build's size
- AC-3: a build that sets only largeArraySize uses the default mechanism
- AC-4: the serializer built with json-stringify keeps that behaviour

**Hidden tests:**

- a later build without options uses the defaults
- a later build setting only the mechanism gets the default size
- a later build setting only the size gets the default mechanism
- a default build after a size-only build is unaffected for large arrays
- the json-stringify serializer keeps its behaviour

**Reference:** reference/. **Incorrect (must fail):** reset-mechanism-only, reset-size-only

## FJ-02 — errors (fast-json-stringify)

**Prompt:** Serializing an invalid Date (e.g. new Date('nope')) for a string with format date-time, date or time crashes with a bare 'RangeError: Invalid time value' from toISOString. Throw the library's usual conversion error instead, with the value as String(date) prints it: `The value "Invalid Date" cannot be converted to a date-time.` (and the same with date or time for those formats). Valid dates and strings serialize as before.

**Acceptance criteria:**

- AC-1: date-time with new Date('nope') throws 'The value "Invalid Date" cannot be converted to a date-time.'
- AC-2: format date and format time throw the same wording with 'date' and 'time'
- AC-3: the error is not a RangeError
- AC-4: valid dates and strings still serialize

**Hidden tests:**

- date-time: invalid Date
- date: invalid Date
- time: invalid Date
- valid values still serialize

**Reference:** reference/. **Incorrect (must fail):** date-time-only, empty-string

## FJ-03 — addition (fast-json-stringify)

**Prompt:** Let date-time strings accept numeric timestamps: a number given for a { type: 'string', format: 'date-time' } property should be treated as milliseconds since the epoch and serialized as the ISO date-time string of new Date(n). A number that is not a valid timestamp (NaN, Infinity, -Infinity, or outside the range a JavaScript Date can represent, ±8.64e15 ms) must throw the library's usual conversion error, `The value "<n>" cannot be converted to a date-time.` with the number as JavaScript prints it. Date objects, strings and the date and time formats are unchanged.

**Acceptance criteria:**

- AC-1: 0 serializes as "1970-01-01T00:00:00.000Z"
- AC-2: 1704164645000 serializes as "2024-01-02T03:04:05.000Z" (milliseconds, not seconds)
- AC-3: NaN and Infinity throw 'The value "NaN" / "Infinity" cannot be converted to a date-time.'
- AC-4: the largest representable timestamp 8.64e15 serializes as "+275760-09-13T00:00:00.000Z"; 8640000000000001 throws 'The value "8640000000000001" cannot be converted to a date-time.'
- AC-5: Date objects and strings behave as before

**Hidden tests:**

- 0 is the epoch
- milliseconds, not seconds
- the output is valid JSON with a string
- NaN is rejected with the usual error
- Infinity is rejected with the usual error
- the largest representable timestamp serializes
- a finite timestamp outside the Date range is rejected with the usual error
- Date objects and strings are unchanged

**Reference:** reference/. **Incorrect (must fail):** finite-only, seconds, unguarded, unquoted

## FJ-04 — already_satisfied (fast-json-stringify)

**Prompt:** Integer fields should accept BigInt values: serialize 10n as 10, and keep very large BigInts exact (no rounding through Number).

**Acceptance criteria:**

- AC-1: 10n serializes as 10
- AC-2: 2n ** 64n serializes exactly as 18446744073709551616
- AC-3: -5n serializes as -5
- AC-4: plain numbers are unchanged

**Hidden tests:**

- 10n
- 2n ** 64n is exact
- negative BigInt
- numbers unchanged

**Reference:** none (already satisfied: the correct change is no change). **Incorrect (must fail):** reject-bigint, via-number

## FJ-05 — errors (fast-json-stringify)

**Prompt:** largeArraySize validation is too lax: '20000abc' and '1.5' are accepted as strings (parseInt keeps the leading digits), negative sizes like -5 or -5n are accepted, and falsy values such as 0 are silently ignored. Whenever largeArraySize is given (any value other than undefined), accept only a positive whole size: a positive integer number, a positive BigInt, or a string of decimal digits only that denotes a positive integer. Reject everything else, including 0, '0', 0n, false, '', null, non-integer numbers and NaN, with the existing error `Unsupported large array size. Expected integer-like, got <typeof value> with value <value>`. Leaving the option out keeps the default size.

**Acceptance criteria:**

- AC-1: '20000abc', '1.5', ' 100' and '1e3' throw 'Unsupported large array size. Expected integer-like, got string with value …'
- AC-2: -5 and -5n throw the same error (with number / bigint)
- AC-3: 0, '0', 0n, false, '', null, 1.5 and NaN are given values and throw the same error (null reports 'object')
- AC-4: 100, '100' and 100n are accepted
- AC-5: an omitted largeArraySize uses the default

**Hidden tests:**

- '20000abc' is rejected
- '1.5' is rejected
- ' 100' is rejected
- '1e3' is rejected
- -5 is rejected
- -5n is rejected
- zero and other falsy values are given values and are rejected
- non-integer numbers are rejected
- an omitted size uses the default
- valid sizes work

**Reference:** reference/. **Incorrect (must fail):** number-coercion, strings-only, truthy-guard

## FJ-06 — integration (fast-json-stringify)

**Prompt:** Add a 'halfEven' option to integer rounding (banker's rounding): build(schema, { rounding: 'halfEven' }) should round values exactly halfway between two integers to the even one, and otherwise round to the nearest integer.

**Acceptance criteria:**

- AC-1: build({ type: 'integer' }, { rounding: 'halfEven' }) is accepted
- AC-2: halves go to the even integer: 0.5→0, 1.5→2, 2.5→2, -2.5→-2, -3.5→-4
- AC-3: non-halves round to nearest: 2.4→2, 2.6→3, -2.6→-3
- AC-4: unknown methods still throw; 'round' is unchanged

**Hidden tests:**

- the option is accepted
- positive halves go to even
- negative halves go to even
- non-halves round to nearest
- integers are unchanged
- unknown methods still throw
- round is unchanged

**Reference:** reference/. **Incorrect (must fail):** negatives-round, plain-round, serializer-only

## FP-01 — state (fastify-plugin)

**Prompt:** fastify-plugin modifies the options object it is given: wrapping two plugins with the same options object (const opts = {}; fp(a, opts); fp(b, opts)) gives the second plugin the first one's auto-generated name, and opts gains a name property. Don't touch the caller's object, and keep the plugin's metadata (fn[Symbol.for('plugin-meta')]) as the plugin's own copy, so later changes the caller makes to their object don't change it. Explicit names, auto names, the display name and the camelCase alias work as before.

**Acceptance criteria:**

- AC-1: after fp(alpha, opts), opts is still {}
- AC-2: fp(alpha, opts) then fp(beta, opts) names the second plugin from beta, not alpha
- AC-3: changing opts after wrapping does not change the plugin's metadata
- AC-4: an explicit name still sets the display name and the camelCase alias

**Hidden tests:**

- the caller options object is not modified
- a shared options object does not leak names
- metadata is a copy
- auto-named metadata survives
- explicit names still work

**Reference:** reference/. **Incorrect (must fail):** copy-on-autoname, delete-after

## FP-02 — bug_fix (fastify-plugin)

**Prompt:** The camelCase alias fastify-plugin derives from a plugin name isn't always a valid identifier: 'my--plugin' gives 'my-plugin', 'plugin-' stays 'plugin-', and '@a/b/c-d' gives 'aB/cD'. Fix lib/toCamelCase.js so hyphens and slashes never survive: drop a leading '@', split the rest on runs of '-' and '/', ignore empty pieces, keep the first piece as is and upper-case only the first character of each following piece. So 'my--plugin' → 'myPlugin', 'plugin-' → 'plugin', '@a/b/c-d' → 'aBCD', '@scope/my-plugin' → 'scopeMyPlugin', 'fooBar-baz' → 'fooBarBaz', 'my_plugin' → 'my_plugin'. The alias fp sets on the plugin follows the same rule.

**Acceptance criteria:**

- AC-1: 'my--plugin' → 'myPlugin' and 'plugin-' → 'plugin'
- AC-2: '@a/b/c-d' → 'aBCD' and '@scope/my-plugin' → 'scopeMyPlugin'
- AC-3: existing capitals and underscores are kept: 'fooBar-baz' → 'fooBarBaz', 'my_plugin' → 'my_plugin'
- AC-4: fp(fn, { name: 'my--plugin' }).myPlugin === fn

**Hidden tests:**

- the alias on the plugin follows the rule
- one test per case: { '@scope/my-plugin': 'scopeMyPlugin', 'my--plugin': 'myPlugin', 'plugin-': 'plugin', '@a/b/c-d': 'aBCD', 'fooBar-baz': 'fooBarBaz', my_plugin: 'my_plugin', simple: 'simple' }

**Reference:** reference/. **Incorrect (must fail):** dash-runs-only, lowercase-rest

## FP-03 — errors (fastify-plugin)

**Prompt:** Passing a non-string plugin name (fp(fn, { name: 123 })) crashes with an unhelpful 'name.replace is not a function'. Validate it like the fastify version option: when name is given and is not a string (including false and null), throw a TypeError with message `fastify-plugin expects a name string, instead got '<typeof name>'` (null reports 'object'). A missing name or the empty string '' keeps the automatic naming, and string names work as before.

**Acceptance criteria:**

- AC-1: fp(fn, { name: 123 }) throws TypeError "fastify-plugin expects a name string, instead got 'number'"
- AC-2: objects, booleans and null are rejected the same way
- AC-3: no name or name '' still auto-names the plugin
- AC-4: string names work as before

**Hidden tests:**

- a number is rejected
- an object is rejected
- false is rejected
- null is rejected
- no name auto-names
- '' auto-names
- string names work

**Reference:** reference/. **Incorrect (must fail):** coerce, truthy-only

## FP-04 — addition (fastify-plugin)

**Prompt:** Add a getPluginMeta(value) export (require('fastify-plugin').getPluginMeta) that returns the metadata fastify-plugin attached to a wrapped function (its options: name, fastify version, etc.). Return a copy: changing the returned object must not change the plugin's metadata. For anything else (a function that wasn't wrapped, a plain object, null or undefined) return undefined, and never throw.

**Acceptance criteria:**

- AC-1: getPluginMeta(fp(fn, { name: 'a', fastify: '5.x' })) has name 'a' and fastify '5.x'
- AC-2: auto-named plugins report their generated name
- AC-3: mutating the returned object does not change a later getPluginMeta result or the plugin's metadata
- AC-4: unwrapped functions, plain objects, null and undefined give undefined without throwing

**Hidden tests:**

- reports the attached options
- auto names are reported
- the result is a copy
- unwrapped functions give undefined
- null, undefined and objects give undefined

**Reference:** reference/. **Incorrect (must fail):** live-object, unguarded

## FP-05 — already_satisfied (fastify-plugin)

**Prompt:** Allow a version string as the second argument: fp(fn, '5.x') should be shorthand for fp(fn, { fastify: '5.x' }).

**Acceptance criteria:**

- AC-1: fp(fn, '5.x') does not throw
- AC-2: its metadata has fastify '5.x'
- AC-3: it is auto-named from the function name

**Hidden tests:**

- a version string is accepted
- it sets the fastify range
- the plugin is auto-named

**Reference:** none (already satisfied: the correct change is no change). **Incorrect (must fail):** reject-strings, string-as-name

## LM-01 — bug_fix (light-my-request)

**Prompt:** Falsy JSON payloads are dropped: inject(dispatch, { method: 'POST', url: '/', payload: 0 }) sends an empty body with no content-type, and so does payload: false, while payload: 1 and payload: true are sent as JSON. Send 0 and false the same way as other non-string values (JSON body, content-type application/json, content-length), whether given as payload or as body. undefined and null still mean no payload, and string, buffer and object payloads are unchanged.

**Acceptance criteria:**

- AC-1: payload: 0 sends body '0' with content-type application/json and content-length 1
- AC-2: payload: false sends body 'false' with content-type application/json
- AC-3: body: 0 (no payload) sends '0'
- AC-4: payload: null sends no body
- AC-5: payload: 1 and object payloads are unchanged

**Hidden tests:**

- payload 0 is sent as JSON
- payload false is sent as JSON
- body 0 is sent when there is no payload
- payload null sends nothing
- payload 1 and objects are unchanged
- string payloads are unchanged

**Reference:** reference/. **Incorrect (must fail):** string-not-json, zero-only

## LM-02 — bug_fix (light-my-request)

**Prompt:** query values that are undefined end up in the URL as the text 'undefined': inject(dispatch, { url: '/', query: { a: undefined, b: 1 } }) requests /?a=undefined&b=1. Leave undefined values out of the query string, including undefined entries inside array values; an undefined value must not add, replace or remove a parameter (a parameter already in the url stays). Other values, including null, 0 and '', are serialized as before, and string queries are unchanged.

**Acceptance criteria:**

- AC-1: query { a: undefined, b: 1 } gives /?b=1
- AC-2: query { c: [1, undefined, 2] } gives /?c=1&c=2
- AC-3: an undefined value does not remove a parameter already in the url
- AC-4: null, 0 and '' are still serialized as before

**Hidden tests:**

- undefined values are omitted
- undefined array elements are skipped
- an undefined value leaves an existing url parameter alone
- null, 0 and empty string are still serialized
- string queries are unchanged

**Reference:** reference/. **Incorrect (must fail):** delete-existing, empty-string, top-level-only

## LM-03 — addition (light-my-request)

**Prompt:** The chainable API can't set the client address or the authority: add .remoteAddress(address) and .authority(host) to the chain returned by inject(dispatch), working like .headers() / .query(): each sets the inject option of the same name (remoteAddress → req.socket.remoteAddress; authority → the Host header) and returns the chain, and calling either after the request has been invoked throws 'The dispatch function has already been invoked'.

**Acceptance criteria:**

- AC-1: inject(d).get('/').remoteAddress('10.0.0.1') makes req.socket.remoteAddress '10.0.0.1'
- AC-2: inject(d).get('/').authority('example.test') makes req.headers.host 'example.test'
- AC-3: both return the chain (calls can be chained)
- AC-4: calling either after the request is invoked throws 'The dispatch function has already been invoked'

**Hidden tests:**

- remoteAddress sets the socket address
- authority sets the host header
- they chain with the other setters
- remoteAddress after invocation throws
- authority after invocation throws

**Reference:** reference/. **Incorrect (must fail):** remote-only, unguarded

## LM-04 — errors (light-my-request)

**Prompt:** A header set to null is sent as the literal string 'null' (headers: { 'x-a': null } arrives as x-a: null). Reject it the same way undefined header values are rejected, with the message 'invalid value "null" for header <name>'. undefined keeps its existing message, and other values such as 0, false and '' are still sent as strings.

**Acceptance criteria:**

- AC-1: headers { 'x-a': null } fails with message 'invalid value "null" for header x-a'
- AC-2: headers { 'x-a': undefined } still fails with 'invalid value "undefined" for header x-a'
- AC-3: 0, false and '' header values are still sent as '0', 'false', ''

**Hidden tests:**

- null is rejected
- undefined keeps its message
- falsy non-null values are still sent

**Reference:** reference/. **Incorrect (must fail):** drop-null, other-wording

## LM-05 — refactor (light-my-request)

**Prompt:** Refactor: move the chainable request builder (Chain and its methods) out of index.js into lib/chain.js, exported as a named export Chain, and have index.js use it (inject() returns a Chain from lib/chain.js). inject() keeps the same behaviour.

**Acceptance criteria:**

- AC-1: require('lib/chain').Chain is a function and inject(d) returns an instance of it
- AC-2: inject builds its chain from lib/chain (replacing that module changes what inject returns)
- AC-3: index.js no longer defines Chain (as a declaration, function expression or arrow function)
- AC-4: chain setters, end(cb), await and autostart behave as before
- AC-5: re-invoking still throws 'The dispatch function has already been invoked'

**Hidden tests:**

- lib/chain exports Chain and inject returns it
- inject builds its chain from lib/chain
- index.js no longer defines Chain
- setters and await work
- end(callback) works
- autostart runs the request
- re-invoking throws the same error

**Reference:** reference/. **Incorrect (must fail):** copy-kept, default-export, reworded-error

## LM-06 — already_satisfied (light-my-request)

**Prompt:** When a request has both a Cookie header and the cookies option, the cookies option must not wipe out the header: send both, with the header's cookies first.

**Acceptance criteria:**

- AC-1: header 'a=1' plus cookies { b: '2' } gives Cookie 'a=1; b=2'
- AC-2: cookies alone give 'b=2; c=3'
- AC-3: a Cookie header alone is sent unchanged

**Hidden tests:**

- header first, then cookies
- cookies alone
- header alone

**Reference:** none (already satisfied: the correct change is no change). **Incorrect (must fail):** cookies-first, overwrite

## LM-07 — addition (light-my-request)

**Prompt:** Chained setters replace instead of adding up: inject(d).get('/').headers({ a: '1' }).headers({ b: '2' }) only sends header b, and the same happens with .query() and .cookies(). Make repeated object calls merge (later keys win), including with values given in the initial inject options. A non-object value, such as a string query, still replaces. Never modify the objects the caller passed in.

**Acceptance criteria:**

- AC-1: headers({ a: '1' }).headers({ b: '2' }) sends both a and b
- AC-2: a later value for the same key wins
- AC-3: inject(d, { url: '/', headers: { a: '1' } }).headers({ b: '2' }) sends both
- AC-4: query objects merge; a string query replaces
- AC-5: the caller's original headers object is not modified

**Hidden tests:**

- headers accumulate
- later values win
- initial options merge with chained headers
- query objects merge
- a string query replaces
- cookies merge
- the caller's object is not modified

**Reference:** reference/. **Incorrect (must fail):** headers-only, mutating-merge

## PW-01 — bug_fix (process-warning)

**Prompt:** Warnings don't interpolate falsy values. With const w = createWarning({ name: 'W', code: 'C', message: 'count=%d' }), w.format(0) returns 'count=%d' instead of 'count=0', and calling w(0) emits the uninterpolated message too. Fix it so that every argument passed (including 0, '', false and null) is interpolated into the message, both by format() and in the emitted warning. The warning function always forwards three arguments to format, so trailing undefined arguments count as not passed and must never appear in the message; an undefined that comes before a passed argument is interpolated like any other value.

**Acceptance criteria:**

- AC-1: createWarning({ name: 'W', code: 'C', message: 'count=%d' }).format(0) returns 'count=0'
- AC-2: format interpolates '', false and null (message 'v=%s' with null gives 'v=null')
- AC-3: the message emitted by calling the warning with 0 is 'count=0' (no trailing 'undefined')
- AC-4: trailing undefined arguments are not supplied: format(undefined) returns the message unchanged and format(0, undefined) on 'a=%s b=%s' gives 'a=0 b=%s'
- AC-5: an undefined before a supplied argument is interpolated: format('x', undefined, 'z') on '%s,%s,%s' gives 'x,undefined,z'
- AC-6: format() with no arguments returns the message unchanged, and truthy arguments interpolate as before

**Hidden tests:**

- format(0) interpolates 0
- format('') interpolates the empty string
- format(false) interpolates false
- format(null) interpolates null
- a falsy second argument is interpolated
- falsy second and third arguments are interpolated
- no arguments: the message is unchanged
- trailing undefined is not supplied
- an undefined before a supplied argument is interpolated
- truthy arguments interpolate as before
- the emitted message interpolates 0 and has no trailing undefined
- the emitted message with two arguments, one falsy

**Reference:** reference/. **Incorrect (must fail):** arguments-length, first-arg-only, null-excluded

## PW-02 — bug_fix (process-warning)

**Prompt:** spyWarning loses falsy arguments: after const spy = spyWarning(w), calling w('a', 0) records spy.calls[0].arguments as ['a'] instead of ['a', 0], and w(0) records []. Make the spy record the arguments the warning was called with, including 0, '', false and null. The warning function always receives three parameters, so trailing undefined arguments are not recorded (they cannot be told apart from omitted ones); an undefined that comes before a recorded argument is kept in its position.

**Acceptance criteria:**

- AC-1: w('a', 0) records arguments ['a', 0]
- AC-2: w(0) records [0], w('') records [''], w(false) records [false] and w(null) records [null]
- AC-3: w() and w(undefined) record []; w('a', undefined) records ['a']
- AC-4: w('a', undefined, 'c') records ['a', undefined, 'c']
- AC-5: callCount still counts every call

**Hidden tests:**

- w('a', 0) keeps the 0
- w(0) keeps the 0
- w('') keeps the empty string
- w(false) keeps false
- w(null) keeps null
- w() records no arguments
- trailing undefined is not recorded
- w('a', undefined, 'c') keeps the hole in position
- truthy arguments are recorded as before
- callCount still counts every call

**Reference:** reference/. **Incorrect (must fail):** always-three, filter-undefined, null-dropped

## PW-03 — errors (process-warning)

**Prompt:** createWarning crashes with an unhelpful TypeError ('code.toUpperCase is not a function') when code is not a string, and silently accepts a non-string name or message. Validate them. For each of name, code and message: a missing value (undefined), null or '' keeps throwing the existing Error 'Warning <field> must not be empty'; any other value that is not a string (numbers including 0, booleans including false, objects, arrays) throws an Error with message 'Warning <field> must be a string'. Valid strings behave as before.

**Acceptance criteria:**

- AC-1: code: 123 throws an Error with message 'Warning code must be a string'
- AC-2: name: {} throws 'Warning name must be a string'; message: 42 throws 'Warning message must be a string'; an array code is rejected the same way
- AC-3: falsy non-strings are not 'empty': code: 0 and message: false throw 'must be a string'
- AC-4: undefined, null and '' still throw 'Warning <field> must not be empty'
- AC-5: valid string fields create a working warning

**Hidden tests:**

- a numeric code is rejected with a clear message
- an object name is rejected
- a numeric message is rejected
- an array code is rejected
- a zero code is not empty: it is not a string
- a false message is not empty: it is not a string
- a null name still reports emptiness
- an empty code still reports emptiness
- a missing name still reports emptiness
- valid input still works and upper-cases the code

**Reference:** reference/. **Incorrect (must fail):** code-only, coerce, truthy-first, typeerror-wording

## PW-04 — addition (process-warning)

**Prompt:** Add an isWarning(value) export (also on the default and processWarning namespace objects) that returns true for a warning item created by createWarning or createDeprecation and false for anything else, including other functions, objects that merely copy a warning's properties, null and undefined. It returns a boolean and never throws.

**Acceptance criteria:**

- AC-1: isWarning(createWarning({...})) === true and isWarning(createDeprecation({...})) === true
- AC-2: isWarning returns false for plain functions, objects that mimic a warning's properties, null and undefined
- AC-3: isWarning is available as require('process-warning').isWarning and on .default and .processWarning
- AC-4: the result is a boolean

**Hidden tests:**

- a created warning is a warning
- a created deprecation is a warning
- a plain function is not
- an object copying the public properties is not
- a function with copied properties is not
- null and undefined are not, and do not throw
- exported on every namespace

**Reference:** reference/. **Incorrect (must fail):** duck-typing, throws-on-null, truthy-not-boolean

## PW-05 — already_satisfied (process-warning)

**Prompt:** Tests need to re-trigger once-only warnings. Make it possible to emit a once-only warning again by setting warning.emitted = false, without making it unlimited: it must still emit only once between resets.

**Acceptance criteria:**

- AC-1: a once-only warning emits on the first call only (later calls return false)
- AC-2: after warning.emitted = false, the next call emits and returns true
- AC-3: after that re-emission it is once-only again
- AC-4: unlimited warnings are unaffected

**Hidden tests:**

- once-only: first call true, later calls false
- emitted = false allows exactly one more emission
- a second reset works too
- emissions actually reach process warnings
- unlimited warnings still emit every time

**Reference:** none (already satisfied: the correct change is no change). **Incorrect (must fail):** always-emit, closure-flag

## PW-06 — refactor (process-warning)

**Prompt:** Refactor: move spyWarning out of index.js into lib/spy.js (named export spyWarning), and move the internal symbols it shares with createWarning into lib/symbols.js, which exports them; index.js and lib/spy.js both take the symbols from lib/symbols.js. index.js re-exports spyWarning from lib/spy.js. The public API must behave exactly as before.

**Acceptance criteria:**

- AC-1: require('lib/spy').spyWarning is the function exported by index.js, and index.js takes it from lib/spy
- AC-2: index.js does not define spyWarning (as a declaration, function expression or arrow function)
- AC-3: lib/symbols.js exports the shared symbols; createWarning and lib/spy.js both use them
- AC-4: spying records calls and callCount; reset clears calls and emitted; restore detaches the spy
- AC-5: spying the same warning twice returns the same spy data

**Hidden tests:**

- lib/spy exports the same spyWarning
- index.js re-exports spyWarning from lib/spy
- index.js no longer defines spyWarning
- lib/symbols.js holds the shared symbols that createWarning and the spy both use
- calls and callCount
- reset clears calls and emitted
- restore detaches the spy
- spying twice returns the same data

**Reference:** reference/. **Incorrect (must fail):** copy-kept, own-symbols
