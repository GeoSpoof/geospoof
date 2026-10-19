# GeoSpoof API Documentation

Technical documentation for the GeoSpoof browser extension (Firefox + Chromium + Safari).

## Table of Contents

1. [API Override Summary](#api-override-summary)
2. [Injected Script Architecture](#injected-script-architecture)
3. [Message Types and Payloads](#message-types-and-payloads)
4. [Settings Schema](#settings-schema)
5. [Data Models](#data-models)
6. [External API Integration](#external-api-integration)
7. [Known Limitations](#known-limitations)
8. [Performance Targets](#performance-targets)
9. [Browser Compatibility](#browser-compatibility)

## API Override Summary

All overrides are injected synchronously at `document_start` before any page JavaScript runs.

> **Chromium note:** the tables below describe the page-world content-script
> injection path, which is the default on every engine. Chromium also ships an
> optional **Engine-level Spoofing** mode that instead drives the _timezone_
> override through the Chrome DevTools Protocol (`chrome.debugger`) — see
> [Engine-level Spoofing (Chromium)](#engine-level-spoofing-chromium). It is
> off by default; geolocation always stays on the injected path.

### Geolocation (`Geolocation.prototype`)

Overrides are installed on `Geolocation.prototype` (not on the per-window `navigator.geolocation` instance), preserving the WebIDL-specified native descriptor shape (`writable: true, configurable: true, enumerable: true`). This matches native layout: `Object.getOwnPropertyDescriptor(navigator.geolocation, "getCurrentPosition")` correctly returns `undefined` because the method is inherited from the prototype.

Spoofed `GeolocationPosition` and `GeolocationCoordinates` instances are allocated via `Object.create(...)` with values stored in WeakMaps, so they have zero own properties — `Object.getOwnPropertyNames(pos)` returns `[]`, matching native.

| API                                                                                                            | Override Behavior                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Geolocation.prototype.getCurrentPosition`                                                                     | Validates `this` and arguments per WebIDL; invalid calls are delegated to the unbound native method so the browser throws its own `TypeError` (correct message + native stack, extension frames scrubbed — see [Argument validation & error fidelity](#argument-validation--error-fidelity-geolocation)). Otherwise returns spoofed coords with 10-50ms realistic delay; serves cached result sub-millisecond when `maximumAge` is honored |
| `Geolocation.prototype.watchPosition`                                                                          | Same argument/`this` validation and native error delegation as `getCurrentPosition`. Otherwise initial callback at 10-50ms; re-fires every 1-2s matching native stationary-device cadence                                                                                                                                                                                                                                                  |
| `Geolocation.prototype.clearWatch`                                                                             | Brand-checks `this` (foreign `this` delegated to native for a faithful `TypeError`); clears spoofed watch                                                                                                                                                                                                                                                                                                                                  |
| `GeolocationCoordinates.prototype.{latitude, longitude, accuracy, altitude, altitudeAccuracy, heading, speed}` | Accessor getters that read from WeakMap slots for spoofed instances and fall through to native for pristine instances                                                                                                                                                                                                                                                                                                                      |
| `GeolocationPosition.prototype.{coords, timestamp}`                                                            | Same accessor pattern as above                                                                                                                                                                                                                                                                                                                                                                                                             |
| `GeolocationPosition.prototype.toJSON`                                                                         | Returns populated shape from WeakMap slots for spoofed instances, keys in the engine's native serialization order (see [Geolocation toJSON key order](#geolocation-tojson-key-order)); falls through to native for pristine instances                                                                                                                                                                                                      |
| `GeolocationCoordinates.prototype.toJSON`                                                                      | Same pattern; returns the seven coordinate fields in the engine's native key order                                                                                                                                                                                                                                                                                                                                                         |

### Argument validation & error fidelity (Geolocation)

`getCurrentPosition`, `watchPosition`, and `clearWatch` reproduce native WebIDL semantics for invalid input instead of silently accepting it:

- **`this` and argument validation.** The override mirrors the WebIDL checks — `this` must implement `Geolocation`, `successCallback` must be callable, `errorCallback` (if present) must be callable, and `options` (if present) must be an object. A call that fails any check (e.g. `getCurrentPosition()`, `getCurrentPosition({})`, `getCurrentPosition(fn, fn, "b")`, or a detached `getCurrentPosition.call({}, fn)`) is **delegated to the unbound native method** so the browser throws its _own_ `TypeError` — correct type, exact per-engine message (e.g. Chrome's `Illegal invocation`), and a native-shaped stack. Validation happens before any permission prompt or location acquisition, so no prompt fires and no real position is requested.
- **No extension-id leak.** Because the injected script runs in `world: "MAIN"`, a thrown error's stack would otherwise carry a `chrome-extension://<id>/…` frame, exposing the extension. The delegating helper strips this script's own frames from the error's stack before rethrowing, leaving a native-equivalent stack (message + page frames only). Detection is restricted to extension-scheme URLs so page frames are never removed.
- **Leak-safe delegation.** Any _valid_ callback is swapped for a no-op before delegating, so even in the spec-impossible case the native call doesn't throw, the page's real callbacks can never receive a real position. Original argument count is preserved so the native message ("1 argument required…" vs a type error) matches exactly.

### Geolocation `toJSON` key order

The `[Default] object toJSON()` serializer emits keys in the interface's WebIDL attribute-declaration order, which is **engine-specific** and is _not_ the prototype's own-property order. Spoofed instances are `Object.create(...)` fakes, so native `toJSON` can't be called on them (it brand-checks and throws), and the order can't be sampled without a real position — so the extension encodes the two known native orders and selects by build target (`__CHROMIUM__` / `__FIREFOX__` / `__SAFARI__`). In preserve-prompt mode, where a genuine native position is briefly available, the order is sampled at runtime and takes precedence over the hardcoded default (self-correcting if an engine ever changes).

| Engine family              | `GeolocationCoordinates` order                                              | `GeolocationPosition` order |
| -------------------------- | --------------------------------------------------------------------------- | --------------------------- |
| Blink (Chromium/Edge/etc.) | `accuracy, latitude, longitude, altitude, altitudeAccuracy, heading, speed` | `timestamp, coords`         |
| Gecko (Firefox)            | `latitude, longitude, altitude, accuracy, altitudeAccuracy, heading, speed` | `coords, timestamp`         |
| WebKit (Safari)            | `latitude, longitude, altitude, accuracy, altitudeAccuracy, heading, speed` | `coords, timestamp`         |

Sources:

- Serializer definition (spec): <https://www.w3.org/TR/geolocation/> — added in <https://github.com/w3c/geolocation/commit/09b48e6>
- MDN (documents the observed Blink output): <https://developer.mozilla.org/en-US/docs/Web/API/GeolocationCoordinates/toJSON>, <https://developer.mozilla.org/en-US/docs/Web/API/GeolocationPosition/toJSON>
- Gecko IDL: <https://github.com/mozilla/gecko-dev/blob/master/dom/webidl/GeolocationCoordinates.webidl>, <https://github.com/mozilla/gecko-dev/blob/master/dom/webidl/GeolocationPosition.webidl>
- WebKit IDL: <https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/geolocation/GeolocationCoordinates.idl>, <https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/geolocation/GeolocationPosition.idl>
- Blink intent-to-ship: <https://groups.google.com/a/chromium.org/g/blink-dev/c/JQkvFd0oXUI>

### Permissions (`Permissions.prototype`)

Installed on `Permissions.prototype` preserving native descriptor flags.

| API                                                    | Override Behavior                                                                              |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `Permissions.prototype.query({ name: "geolocation" })` | Returns a prototype-linked `PermissionStatus` with `state: "granted"` when spoofing is enabled |
| `Permissions.prototype.query({ name: other })`         | Passthrough to native                                                                          |

### Date constructor and statics

| API                              | Override Behavior                                       |
| -------------------------------- | ------------------------------------------------------- |
| `Date` (global)                  | Replaced entirely — spoofing-aware constructor          |
| `Date()` constructor (no-arg)    | Passthrough (current time)                              |
| `Date(string)` — ambiguous       | Epoch adjusted by offset difference                     |
| `Date(string)` — explicit tz     | Passthrough                                             |
| `Date(y, m, d, ...)` — multi-arg | Epoch adjusted by offset difference                     |
| `Date.parse(string)`             | Same adjustment as constructor                          |
| `Date.now`                       | Behavior passthrough; registered for `toString` masking |
| `Date.UTC`                       | Behavior passthrough; registered for `toString` masking |
| `Date.prototype.constructor`     | Re-pointed to the replacement constructor               |

### Date.prototype methods

| API                                    | Override Behavior                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Date.prototype.getTimezoneOffset`     | Negated Intl-based offset for spoofed tz                                                                                                   |
| `Date.prototype.toString`              | Formatted with spoofed tz name and offset                                                                                                  |
| `Date.prototype.toDateString`          | Formatted in spoofed timezone                                                                                                              |
| `Date.prototype.toTimeString`          | Formatted with spoofed offset and tz name                                                                                                  |
| `Date.prototype.toLocaleString`        | Timezone injected into options                                                                                                             |
| `Date.prototype.toLocaleDateString`    | Timezone injected into options                                                                                                             |
| `Date.prototype.toLocaleTimeString`    | Timezone injected into options                                                                                                             |
| `Date.prototype.getHours`              | Computed via engine-specific path in spoofed tz                                                                                            |
| `Date.prototype.getMinutes`            | Computed via engine-specific path in spoofed tz                                                                                            |
| `Date.prototype.getSeconds`            | Computed via engine-specific path in spoofed tz                                                                                            |
| `Date.prototype.getMilliseconds`       | Behavior passthrough (timezone-independent)                                                                                                |
| `Date.prototype.getDate`               | Computed via engine-specific path in spoofed tz                                                                                            |
| `Date.prototype.getDay`                | Computed via engine-specific path in spoofed tz                                                                                            |
| `Date.prototype.getMonth`              | Computed via engine-specific path in spoofed tz                                                                                            |
| `Date.prototype.getFullYear`           | Computed via engine-specific path in spoofed tz                                                                                            |
| `Date.prototype.setHours(h,m?,s?,ms?)` | Components interpreted in spoofed tz; omitted args preserve current spoofed-zone component; DST-refined                                    |
| `Date.prototype.setMinutes(m,s?,ms?)`  | Components interpreted in spoofed tz; omitted args preserve current spoofed-zone component; DST-refined                                    |
| `Date.prototype.setSeconds(s,ms?)`     | Components interpreted in spoofed tz; omitted args preserve current spoofed-zone component; DST-refined                                    |
| `Date.prototype.setDate(d)`            | Day-of-month interpreted in spoofed tz; time-of-day preserved in spoofed tz; DST-refined                                                   |
| `Date.prototype.setMonth(m,d?)`        | Month (and optional day) interpreted in spoofed tz; time-of-day preserved; DST-refined                                                     |
| `Date.prototype.setFullYear(y,m?,d?)`  | Year (and optional month/day) interpreted in spoofed tz; time-of-day preserved; DST-refined; small-year 0-99 literal (not 1900+y) per spec |
| `Date.prototype.setMilliseconds`       | **Not overridden** — timezone-independent, round-trips natively                                                                            |
| `Date.prototype.setTime`               | **Not overridden** — absolute UTC epoch write with no timezone interpretation                                                              |
| `Date.prototype.setUTC*` (all seven)   | **Not overridden** — UTC surfaces, true UTC epoch preserved                                                                                |
| `Date.prototype.toISOString`           | **Not overridden** — UTC surface, true UTC epoch preserved                                                                                 |
| `Date.prototype.toJSON`                | **Not overridden** — delegates to toISOString, true UTC epoch preserved                                                                    |
| `Date.prototype.getUTC*` (all eight)   | **Not overridden** — UTC surfaces, true UTC values preserved                                                                               |

### Intl

| API                                                | Override Behavior                                                           |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| `Intl.DateTimeFormat` constructor                  | Injects spoofed timezone when no explicit tz                                |
| `Intl.DateTimeFormat.prototype.resolvedOptions`    | Returns spoofed tz for non-explicit instances                               |
| `Intl.DateTimeFormat.prototype.formatToParts`      | Inherits spoofed timezone from the constructor; no separate override needed |
| `Intl.DateTimeFormat.prototype.formatRange`        | Inherits spoofed timezone from the constructor (feature-gated)              |
| `Intl.DateTimeFormat.prototype.formatRangeToParts` | Inherits spoofed timezone from the constructor (feature-gated)              |

### Constructor subclassing fidelity (`new.target`)

`Date` and `Intl.DateTimeFormat` are the only two constructors the extension replaces, and both honor `new.target`: construction routes through `Reflect.construct(Original, args, new.target)`. So `class X extends Date {}` / `class X extends Intl.DateTimeFormat {}`, and `Reflect.construct(Date, args, F)`, yield an instance carrying the caller's prototype — `new X() instanceof X` is `true` and `Object.getPrototypeOf(new X()) === X.prototype`, exactly like native — while the spoofing (epoch adjustment for `Date`, spoofed-zone injection for `Intl.DateTimeFormat`) still applies through the subclass. A plain-function override that `return`ed a fresh instance would discard `new.target`, making `new X() instanceof X` false — a deterministic tell, and a break of legitimate subclassing. Installed identically across the top-level, same-origin iframe, and worker realms.

### Temporal (feature-detected)

| API                                                  | Override Behavior                               |
| ---------------------------------------------------- | ----------------------------------------------- |
| `Temporal.Now.timeZoneId`                            | Returns spoofed identifier                      |
| `Temporal.Now.plainDateTimeISO`                      | Passes spoofed tz when no arg                   |
| `Temporal.Now.plainDateISO`                          | Passes spoofed tz when no arg                   |
| `Temporal.Now.plainTimeISO`                          | Passes spoofed tz when no arg                   |
| `Temporal.Now.zonedDateTimeISO`                      | Passes spoofed tz when no arg                   |
| `Temporal.ZonedDateTime.prototype.offsetNanoseconds` | Passthrough getter; kept for `toString` masking |
| `Temporal.ZonedDateTime.prototype.offset`            | Passthrough getter; kept for `toString` masking |

### Worker-scope overrides (`SPOOF_CORE`)

Web / Shared / Service Workers get a fresh global that never passes through the main-world content-script injection, so `Date` / `Intl.DateTimeFormat` / `Temporal.Now` inside a worker would otherwise report the **real** timezone. The extension closes this by prepending a self-contained ES5 spoofing payload (`SPOOF_CORE`, `src/shared/worker-payload.ts`) to worker scripts — via the content-script `Worker` / `SharedWorker` constructor wrapper for blob / data / nested workers on every engine, and via the Firefox `webRequest.filterResponseData` listener for URL-based / module / service workers (see [Known Limitations](#known-limitations) for the engine matrix; geolocation isn't exposed to workers, so this is a timezone-only concern).

The payload reaches **full parity with the main realm** — every timezone-affecting surface is overridden with identical behavior:

| Surface (in worker scope)                                                               | Override behavior                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Date` constructor + `Date.parse`                                                       | `new.target`-aware (subclassing / `Reflect.construct` preserve the subclass prototype); ambiguous-string and multi-arg construction epoch-adjusted to the spoofed zone; no-`new` `Date()` returns a spoofed-zone string (CreepJS `valid.date` consistency) |
| `Date.prototype.getTimezoneOffset`                                                      | Intl-derived spoofed offset (engine truncation matched)                                                                                                                                                                                                    |
| `Date.prototype` local getters (`getHours`…`getFullYear`, `getDay`)                     | Read in the spoofed zone                                                                                                                                                                                                                                   |
| `Date.prototype.getMilliseconds`                                                        | Passthrough (timezone-independent); registered for `toString` masking                                                                                                                                                                                      |
| `Date.prototype` local setters (`setHours`…`setFullYear`)                               | Components interpreted in the spoofed zone, DST-refined; round-trip against the spoofed getters                                                                                                                                                            |
| `Date.prototype.{toString,toDateString,toTimeString,toLocale*}`                         | Formatted in the spoofed zone                                                                                                                                                                                                                              |
| `Intl.DateTimeFormat` constructor + `resolvedOptions`                                   | `new.target`-aware; injects the spoofed zone when none is explicit                                                                                                                                                                                         |
| `Temporal.Now.{timeZoneId,plainDateTimeISO,plainDateISO,plainTimeISO,zonedDateTimeISO}` | Spoofed identifier / spoofed zone when no explicit arg (feature-detected)                                                                                                                                                                                  |
| `Function.prototype.toString`                                                           | Masks every override as `[native code]`; derives the engine-specific surround format at runtime                                                                                                                                                            |

**Native-method shape fidelity.** Every non-constructor override above is installed through a concise-method wrapper (`__nativeMethod`, the worker-payload twin of the main realm's `stripConstruct`), so it has **no own `prototype` and no `[[Construct]]` slot** — matching native methods, where `new Date.prototype.getHours()` and `Reflect.construct(Date.prototype.getHours, [])` throw `TypeError` — and carries the correct native `name` / `length` / `[native code]` toString. The two real constructors (`Date`, `Intl.DateTimeFormat`) keep their own `prototype` and `[[Construct]]`. Without this, a naive `function(){}` override would carry a `prototype` and be constructable, a worker-side tell distinct from the timezone value.

Not applicable in worker scope (correctly absent): geolocation, permissions, `document.lastModified`, WebRTC, XSLT, iframe / DOM cascade — those APIs don't exist there.

### Document overrides

| API                                        | Override Behavior                                                                                                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Document.prototype.lastModified` (getter) | Reformats the native `"MM/DD/YYYY HH:MM:SS"` string from the real system timezone into the spoofed timezone. Covers `document.lastModified`, `DOMParser`-constructed documents, and `iframe.contentDocument.lastModified` via prototype-level patching. |

### Function masking and stealth infrastructure

| API                           | Override Behavior                                |
| ----------------------------- | ------------------------------------------------ |
| `Function.prototype.toString` | Returns `[native code]` for registered overrides |

### Iframe patching

Two accessor properties on `HTMLIFrameElement.prototype` are wrapped at the top level. When a same-origin iframe window is first accessed, `patchIframeWindow` runs synchronously and installs overrides on the iframe's realm:

1. `Function.prototype.toString` — native-`[native code]`-reporting mask
2. Geolocation — `getCurrentPosition` / `watchPosition` / `clearWatch` on the iframe's `Geolocation.prototype`
3. Permissions — `query` on the iframe's `Permissions.prototype`, returning a prototype-linked `PermissionStatus` with `state: "granted"` for geolocation
4. Intl — `Intl.DateTimeFormat` constructor + `resolvedOptions` on the iframe's realm
5. Date — full spoofing-aware `Date` constructor + `Date.parse` on the iframe's realm
6. Temporal — `Temporal.Now.{timeZoneId,plainDateTimeISO,plainDateISO,plainTimeISO,zonedDateTimeISO}` when available
7. Document — `Document.prototype.lastModified` getter override on the iframe's realm
8. Nested-iframe cascade — iframe-realm copies of `HTMLIFrameElement.prototype.{contentWindow,contentDocument}` getters, `Node.prototype.{appendChild,insertBefore,replaceChild}`, `Element.prototype.{append,prepend,replaceWith,insertAdjacentElement,insertAdjacentHTML}`, the `innerHTML` setter, plus a `MutationObserver` on the iframe's own `documentElement`. This causes nested iframes to trigger `patchIframeWindow` recursively to any depth.

Cross-origin iframes throw `SecurityError` on any access and are silently skipped. All shape/descriptor checks in the cascade use tag-name / duck-typing rather than `instanceof`, because elements created in the iframe's realm are not instances of the top-level constructors.

| API                                                    | Override Behavior                       |
| ------------------------------------------------------ | --------------------------------------- |
| `HTMLIFrameElement.prototype.contentWindow` (getter)   | Patches iframe on access                |
| `HTMLIFrameElement.prototype.contentDocument` (getter) | Triggers `contentWindow` patching first |

### DOM insertion wrapping

Wrapped to synchronously scan inserted subtrees for iframes and patch them before the next line of JavaScript executes. A `MutationObserver` on `document.documentElement` catches anything missed by the wrappers.

| API                                       | Override Behavior                                |
| ----------------------------------------- | ------------------------------------------------ |
| `Node.prototype.appendChild`              | Calls original, then scans inserted node         |
| `Node.prototype.insertBefore`             | Calls original, then scans inserted node         |
| `Node.prototype.replaceChild`             | Calls original, then scans inserted node         |
| `Element.prototype.append`                | Calls original, then scans inserted nodes        |
| `Element.prototype.prepend`               | Calls original, then scans inserted nodes        |
| `Element.prototype.replaceWith`           | Calls original, then scans inserted nodes        |
| `Element.prototype.insertAdjacentElement` | Calls original, then scans inserted element      |
| `Element.prototype.insertAdjacentHTML`    | Calls original, then scans parent subtree        |
| `Element.prototype.innerHTML` (setter)    | Calls original setter, then scans target subtree |

## Engine-level Spoofing (Chromium)

An optional, off-by-default Chromium mode (`Settings.debuggerModeEnabled`,
implemented in `src/background/debugger-spoof.ts`) that applies the **timezone**
override through the Chrome DevTools Protocol instead of page-world injection.
It exists to close two gaps the content-script path cannot cover on Chromium
MV3 (which has no `webRequest.filterResponseData`):

- **Workers** — `Emulation.setTimezoneOverride` applies across every frame _and_
  worker, including module and service workers, so URL-based workers that run
  unpatched under the injection path on Chromium are covered.
- **Cold-start race** — the override is attached on
  `webNavigation.onBeforeNavigate`, before the document's first script runs, so
  there is no early window where the real zone leaks.

| Aspect             | Behavior                                                                                                                                                                                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trigger            | Opt-in only (`debuggerModeEnabled`); no-op when off, on non-Chromium builds, or when `chrome.debugger` is unavailable                                                                                                                                                                          |
| Mechanism          | `chrome.debugger.attach` per in-scope http/https tab, then `Emulation.setTimezoneOverride` with the spoofed IANA id                                                                                                                                                                            |
| Early attach       | `webNavigation.onBeforeNavigate` (runtime `webNavigation` permission); falls back to `tabs.onUpdated` when that permission isn't granted                                                                                                                                                       |
| Scope              | Honors the same per-site all/allowlist/denylist scope as the injection path; out-of-scope or denylisted tabs are detached                                                                                                                                                                      |
| Geolocation        | **Not** handled here — CDP geolocation override races the first `getCurrentPosition` grant, so geolocation stays on the prompt-free injected path                                                                                                                                              |
| Timezone injection | While CDP owns the timezone, the page-world timezone overrides no-op (the broadcast withholds `timezone`); `Date`/`Intl` still report the spoofed zone, now from the engine                                                                                                                    |
| Teardown           | Reverts explicitly (`setTimezoneOverride` with empty id) then detaches; never persists a stale session                                                                                                                                                                                         |
| Permission         | `debugger` is declared **required** (Chrome forbids it in `optional_permissions`) but maps to the existing "access your data on all websites" warning, so it adds no new install prompt. Chrome shows a "GeoSpoof started debugging this browser" bar only while the mode is actually attached |
| State              | Stateless across MV3 service-worker respawns — `chrome.debugger.getTargets()` is the source of truth; settings are read fresh per event                                                                                                                                                        |

## Stealth Properties Verified by Test Suite

The test suite on the verification site validates that every override is indistinguishable from native. For each overridden function, the following eight properties are checked:

1. **toString masking** — `Function.prototype.toString.call(fn)` contains `[native code]`
2. **name** — `fn.name` equals the property name
3. **length** — `fn.length` matches native arity (validated against a clean iframe reference)
4. **no own prototype** — non-constructors have no own `prototype` property; constructors do
5. **non-constructable** — non-constructors throw `TypeError` on `Reflect.construct`; constructors succeed
6. **descriptor flags** — `Object.getOwnPropertyDescriptor` flags match native (validated against a clean iframe reference)
7. **strict-mode .caller** — accessing `.caller` throws `TypeError`
8. **strict-mode .arguments** — accessing `.arguments` throws `TypeError`

For accessor properties (`contentWindow`, `contentDocument`, `innerHTML`), a separate battery validates:

- Accessor descriptor shape (get/set presence, configurable, enumerable)
- No data descriptor where native has an accessor
- Getter/setter function stealth (toString, name, length)

### Additional Shape Fidelity Checks (Geolocation)

| Check                                                                       | What it validates                                              |
| --------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `Object.prototype.toString.call(navigator.geolocation)`                     | Returns `[object Geolocation]` (Symbol.toStringTag brand)      |
| `Object.prototype.toString.call(position)`                                  | Returns `[object GeolocationPosition]`                         |
| `Object.prototype.toString.call(position.coords)`                           | Returns `[object GeolocationCoordinates]`                      |
| `Object.prototype.toString.call(navigator.permissions)`                     | Returns `[object Permissions]`                                 |
| `Object.prototype.toString.call(permissionStatus)`                          | Returns `[object PermissionStatus]`                            |
| `Object.keys(position)`                                                     | Returns `[]` (no own enumerable keys)                          |
| `Object.keys(position.coords)`                                              | Returns `[]` (no own enumerable keys)                          |
| `Object.getOwnPropertyNames(position)`                                      | Returns `[]` (no own string keys at all)                       |
| `Object.getOwnPropertyNames(position.coords)`                               | Returns `[]` (no own string keys at all)                       |
| `Object.getOwnPropertySymbols(position)`                                    | Returns `[]` (no own symbol keys)                              |
| `Object.getOwnPropertySymbols(position.coords)`                             | Returns `[]` (no own symbol keys)                              |
| `Object.getOwnPropertyDescriptor(coords, "latitude")`                       | Returns `undefined` (inherited from prototype)                 |
| `JSON.stringify(position)`                                                  | Produces native-shaped output with coords + timestamp          |
| `Geolocation.prototype.getCurrentPosition.call({}, noop)`                   | Throws `TypeError` (brand check)                               |
| `GeolocationPositionError.{PERMISSION_DENIED,POSITION_UNAVAILABLE,TIMEOUT}` | Constants are 1, 2, 3                                          |
| `position.coords.latitude` decimal precision                                | ≥6 decimal places (realistic GPS precision via jitter padding) |

### Internal Consistency Checks

These tests cross-check independent APIs against each other to detect partial spoofing:

| Cross-check                       | APIs compared                                                                                                                                                                                                                                                         |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Offset agreement                  | `Date.getTimezoneOffset()` vs `Intl.DateTimeFormat` shortOffset                                                                                                                                                                                                       |
| Hour agreement                    | `Date.getHours()` vs `toLocaleTimeString("en-US", { hour12: false })`                                                                                                                                                                                                 |
| Minute agreement                  | `Date.getMinutes()` vs `toLocaleTimeString("en-US", { minute: "2-digit" })`                                                                                                                                                                                           |
| Second agreement                  | `Date.getSeconds()` vs `toLocaleTimeString("en-US", { second: "2-digit" })`                                                                                                                                                                                           |
| Day-of-week agreement             | `Date.getDay()` vs `toLocaleDateString("en-US", { weekday: "long" })`                                                                                                                                                                                                 |
| Month agreement                   | `Date.getMonth()` vs `toLocaleDateString("en-US", { month: "long" })`                                                                                                                                                                                                 |
| Date agreement                    | `Date.getDate()` vs `toLocaleDateString("en-US", { day: "numeric" })`                                                                                                                                                                                                 |
| Year agreement                    | `Date.getFullYear()` vs `toLocaleDateString("en-US", { year: "numeric" })`                                                                                                                                                                                            |
| toString offset vs longOffset     | `Date.toString()` GMT±HHMM vs `toLocaleString(undefined, { timeZoneName: "longOffset" })`                                                                                                                                                                             |
| toTimeString vs getTimezoneOffset | `Date.toTimeString()` GMT offset vs `-getTimezoneOffset()`                                                                                                                                                                                                            |
| toDateString vs Intl              | `Date.toDateString()` weekday/month vs `Intl.DateTimeFormat` short weekday/month                                                                                                                                                                                      |
| Temporal vs Intl                  | `Temporal.Now.zonedDateTimeISO().timeZoneId` vs `Intl.DateTimeFormat().resolvedOptions().timeZone`                                                                                                                                                                    |
| format vs formatToParts           | `Intl.DateTimeFormat.format()` vs concatenation of `formatToParts()` values                                                                                                                                                                                           |
| toLocaleString vs Intl.format     | `Date.toLocaleString("en-US", opts)` vs `new Intl.DateTimeFormat("en-US", opts).format()`                                                                                                                                                                             |
| Offset stability                  | Two `Date` instances from the same ISO string have identical `getTimezoneOffset()`                                                                                                                                                                                    |
| Clock monotonicity                | Two consecutive `Date.now()` calls are monotonically non-decreasing                                                                                                                                                                                                   |
| DST across seasons                | Jan vs Jul `getTimezoneOffset()` differ for DST-observing zones                                                                                                                                                                                                       |
| Cross-method offset (6 surfaces)  | `getTimezoneOffset`, epoch arithmetic, `Date.parse`, Intl shortOffset, component arithmetic (`getUTC*` vs `get*`), `Temporal.Instant.toZonedDateTimeISO().offsetNanoseconds` — all must agree for the same instant across 4 historical years (2025, 1976, 1952, 1879) |

### Iframe Behavioral Tests

Validates that geolocation spoofing works across all iframe injection paths:

| Injection path                       | What's tested                                                      |
| ------------------------------------ | ------------------------------------------------------------------ |
| `contentWindow` getter               | Static access after iframe is in the tree                          |
| `Node.prototype.appendChild`         | DOM insertion wrapper scans subtree                                |
| `Element.prototype.innerHTML` setter | String-based injection path                                        |
| `srcdoc` attribute                   | Synchronous document load from attribute                           |
| `document.write("<iframe>")`         | Parser-based injection (nested iframe via outer iframe's document) |

Each test creates an `about:blank` same-origin iframe, calls `getCurrentPosition` inside it, and asserts the returned coordinates match the top-level identity.

### Iframe Realm Timezone Tests

Validates that timezone spoofing is installed in iframe realms:

| Surface                                                                 | What's tested                                             |
| ----------------------------------------------------------------------- | --------------------------------------------------------- |
| `iframe.contentWindow.Intl.DateTimeFormat().resolvedOptions().timeZone` | Must match top-level Intl resolved zone                   |
| `new iframe.contentWindow.Date("2024-01-01T12:00:00").getTime()`        | Ambiguous string must parse identically to top-level Date |
| `iframe.contentWindow.Temporal.Now.timeZoneId()`                        | Must match top-level Intl resolved zone (feature-gated)   |

### Indirection Bypass Tests (webbrowsertools-style)

| Technique                                        | What's tested                                                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `eval("navigator.geolocation")`                  | Dynamic resolution still hits spoofed coords                                                                    |
| `new Function("return navigator.geolocation")()` | Function constructor indirection still hits spoofed coords                                                      |
| `sandbox="allow-same-origin"` iframe             | Sandboxed iframe's `navigator.geolocation` still returns spoofed coords                                         |
| Instance descriptor parity                       | `Object.getOwnPropertyDescriptor(navigator.geolocation, "getCurrentPosition")` matches pristine iframe baseline |
| Prototype toString                               | `Geolocation.prototype.getCurrentPosition.toString()` contains `[native code]`                                  |

### WebRTC Leak Tests

| Surface                         | What's tested                                                                |
| ------------------------------- | ---------------------------------------------------------------------------- |
| Public IP via srflx candidate   | ICE gathering with STUN server must not reveal a public IP in SDP candidates |
| Host candidate mDNS obfuscation | Host-type candidates must use `.local` mDNS hostnames, not raw LAN IPs       |
| Iframe-realm bypass             | `iframe.contentWindow.RTCPeerConnection` gather must not reveal a public IP  |
| `RTCPeerConnection.getStats()`  | Stats reports must not expose local candidate IP addresses                   |

### IP Geolocation Cross-checks

| Check              | What's tested                                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Country match      | Public IP country (via geojs.io / freeipapi) must match the country of the spoofed coordinates (via Nominatim reverse geocoding) |
| Regional proximity | Public IP location must be within 500km of the spoofed coordinates (Haversine distance)                                          |

### document.lastModified Tests

| Surface                                                         | What's tested                                                         |
| --------------------------------------------------------------- | --------------------------------------------------------------------- |
| `document.lastModified`                                         | Top-level document's lastModified offset matches the spoofed timezone |
| `new DOMParser().parseFromString("", "text/html").lastModified` | DOMParser-constructed document's lastModified offset matches          |
| `iframe.contentDocument.lastModified`                           | Iframe realm's lastModified offset matches                            |

### Worker Timezone Tests

Validates timezone spoofing across every Worker construction pattern. Each surface has three cards — an Intl-zone reach check, a `Temporal.Now.timeZoneId()` reach check, and a full Date/Intl/Temporal parity signature — plus a native-method fidelity card. Blob / data / nested workers are patched on every engine (constructor interception) and live under `timezone-stealth`; URL-based / SharedWorker / importScripts / module workers are patched only on Firefox (`filterResponseData`) and reclassify to `known-limitations` on Chromium/Safari; ServiceWorkers are always `known-limitations`.

| Surface                                                   | What's tested                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blob-URL / data-URL / nested Worker                       | Reported Intl zone, Temporal zone, and full parity signature match the main thread (all engines)                                                                                                                                                                                                                                      |
| URL-based classic / SharedWorker / importScripts / module | Same, on Firefox; documented reach limitation on Chromium/Safari                                                                                                                                                                                                                                                                      |
| ServiceWorker                                             | Same, documented as a known limitation (stable browser-managed URL rules out interception)                                                                                                                                                                                                                                            |
| Full parity signature                                     | Intl zone, `getTimezoneOffset`, ambiguous/multi-arg construction, `Date.parse`, all local getters, a `setHours` round-trip, the formatter family, and `Temporal.Now` — every field must equal the main thread's                                                                                                                       |
| Native-method fidelity (per surface)                      | Every override in the worker has no own `prototype`, is not constructable, and matches native `name` / `length` / `[native code]` toString; the two constructors stay constructable. Served-surface cards **skip** when the payload didn't reach the worker (unpatched = vacuously native), deferring to that surface's timezone card |

### Constructor Subclassing Tests (`new.target`)

Validates that replacing `Date` and `Intl.DateTimeFormat` preserves native constructor semantics (see [Constructor subclassing fidelity](#constructor-subclassing-fidelity-newtarget)):

| Surface                                   | What's tested                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| `class X extends Date {}`                 | `new X() instanceof X` and `Object.getPrototypeOf(new X()) === X.prototype`                |
| `Reflect.construct(Date, [], F)`          | Result's prototype is `F.prototype`                                                        |
| `class X extends Intl.DateTimeFormat {}`  | Same subclass-prototype fidelity, with the spoofed zone still applied through the subclass |
| Iframe realm (Date + Intl.DateTimeFormat) | Same checks against a same-origin iframe's constructors                                    |
| Worker realm (Date + Intl.DateTimeFormat) | Same checks inside the worker payload, with the spoof still intact                         |

## Injected Script Architecture

The injected script runs in page context and overrides browser APIs. It's organized as modular TypeScript files bundled into a single IIFE by Vite.

### Module Initialization Order

Order matters — each module depends on the ones before it:

1. **function-masking** — `toString` masking infrastructure
2. **state** — Original API references captured at import time
3. **date-constructor** — Global `Date` replaced
4. **settings-listener** — CustomEvent listener for settings updates
5. **geolocation** — `getCurrentPosition`, `watchPosition`, `clearWatch`
6. **permissions** — `navigator.permissions.query`
7. **timezone-overrides** — `getTimezoneOffset`, `Intl.DateTimeFormat` constructor + `resolvedOptions`
8. **date-formatting** — `toString`, `toDateString`, `toTimeString`, `toLocale*`
9. **date-getters** — `getHours`, `getMinutes`, `getSeconds`, `getDate`, `getDay`, `getMonth`, `getFullYear`
10. **date-setters** — `setHours`, `setMinutes`, `setSeconds`, `setDate`, `setMonth`, `setFullYear`
11. **temporal** — `Temporal.Now.*` (feature-detected, no-ops if unavailable)
12. **document-overrides** — `Document.prototype.lastModified` getter
13. **iframe-patching** — `contentWindow`/`contentDocument` getter overrides
14. **dom-insertion** — DOM method wrapping + MutationObserver fallback
15. **worker-patching** — `Worker` / `SharedWorker` constructor wrappers that prepend the `SPOOF_CORE` payload to blob / data / nested workers (all engines) and announce URL-based worker requests to the background for the Firefox `filterResponseData` path

### Key Modules

#### state.ts

Centralized mutable state and original API references. All originals captured at module load time before any overrides.

Exports:

- `spoofingEnabled`, `spoofedLocation`, `timezoneData`, `settingsReceived` — mutable state with setter functions
- `OriginalDate`, `OriginalDateParse`, `OriginalDateTimeFormat` — pristine constructors
- `originalGetTimezoneOffset`, `originalToString`, `originalGetHours`, etc. — unbound prototype methods
- `overrideRegistry` — `Map<Function, string>` for toString masking
- `explicitTimezoneInstances` — `WeakSet<Intl.DateTimeFormat>` for self-interference prevention
- `EVENT_NAME` — configurable event name (build-time)

#### function-masking.ts

Anti-fingerprinting infrastructure. Key exports:

- `initFunctionMasking()` — Installs `Function.prototype.toString` override. Must be called first.
- `registerOverride(fn, nativeName)` — Register a function in the override registry
- `disguiseAsNative(fn, nativeName, length)` — Set name/length, delete prototype
- `stripConstruct(fn)` — Wrap in method shorthand to remove `[[Construct]]` and `prototype`
- `installOverride(target, prop, overrideFn)` — Full install: register, disguise, define property. Auto-wraps function expressions via `stripConstruct`.

#### safe-random.ts

Randomness the page can't observe. Overrides must never call the page's `Math.random`: a page can wrap it and see calls native code never makes, and its xorshift128+ stream (V8, SpiderMonkey, JavaScriptCore) is predictable, so a consumed value shows as a skip.

- `randomUnit()` — Uniform float in [0, 1) with 53 bits of entropy from `crypto.getRandomValues`, captured and bound at module load into a pre-allocated `Uint32Array`. Returns `0.5` if `crypto` is missing rather than falling back to `Math.random`.

#### timezone-helpers.ts

Pure utility functions (no side effects on globals):

- `getIntlBasedOffset(date, timezoneId, fallback)` — Resolve UTC offset via `Intl.DateTimeFormat` with `shortOffset`
- `formatGMTOffset(offsetMinutes)` — Convert offset to `GMT±HHMM` string
- `getLongTimezoneName(date, timezoneId)` — Extract long timezone name (e.g. "Pacific Daylight Time")
- `isAmbiguousDateString(str)` — Detect date strings without explicit timezone indicator
- `computeEpochAdjustment(parsedDate, timezoneId, fallback)` — Compute ms adjustment for Date constructor spoofing with iterative DST refinement
- `parseGMTOffset(gmtString)` — Parse `GMT+5:30` style strings to minutes
- `validateTimezoneData(tz)` — Runtime type guard for TimezoneData

#### geolocation.ts

Installs geolocation and position/coordinate overrides on `Geolocation.prototype`, `GeolocationPosition.prototype`, and `GeolocationCoordinates.prototype`. Key exports:

- `installGeolocationOverrides()` — Installs `getCurrentPosition` / `watchPosition` / `clearWatch` on `Geolocation.prototype`, plus prototype-level accessor and `toJSON` installers so spoofed instances have zero own properties (matching native layout — `Object.getOwnPropertyNames(pos)` returns `[]`).
- `getPaddedCoords(location)` — Returns a padded coordinate pair for the given raw spoofed location. Pads values with fewer than 7 decimal places by appending a ±5mm jitter (well below any accuracy a user could configure), caches per unique raw pair, and is shared with `iframe-patching.ts` so main-window and iframe paths emit identical values. Closes the "suspiciously round spoofed coordinates" detection vector.

All randomness here (coordinate jitter, fix latency, watch intervals) comes from `safe-random.ts`, never the page's `Math.random`.

Spoofed positions are allocated via `Object.create(GeolocationPosition.prototype)` with coordinate/timestamp values stored in a module-level `WeakMap<object, slots>`. Prototype getters consult the WeakMap for our instances and fall through to the native getters for pristine browser-allocated objects.

#### document-overrides.ts

Overrides `Document.prototype.lastModified` to reformat the native string in the spoofed timezone. Key exports:

- `installDocumentOverrides()` — Installs the `lastModified` getter override on the top-level `Document.prototype`.
- `installLastModifiedOverride(documentProto)` — Installs the override on any `Document.prototype` (used by `iframe-patching.ts` for iframe realms).

The override parses the native `"MM/DD/YYYY HH:MM:SS"` string (which is in the real system timezone), recovers the UTC epoch, and reformats it in the spoofed timezone using `Intl.DateTimeFormat` via `formatToParts`.

#### iframe-patching.ts

Per-iframe realm patcher. When a same-origin iframe window is first accessed, `patchIframeWindow` installs ten sections of overrides on that iframe's realm:

1. `Function.prototype.toString` — native-[native code]-reporting mask
2. Geolocation — `getCurrentPosition` / `watchPosition` / `clearWatch` on the iframe's `Geolocation.prototype`
3. Permissions — `query` on the iframe's `Permissions.prototype`, returning a prototype-linked `PermissionStatus` with `state: "granted"` for geolocation
4. Intl — `Intl.DateTimeFormat` constructor + `resolvedOptions` on the iframe's realm
5. Date — full spoofing-aware `Date` constructor + `Date.parse` on the iframe's realm
6. Date.prototype methods — full per-method overrides on the iframe's `Date.prototype` via the parameterized installers from `date-getters.ts`, `date-setters.ts`, `date-formatting.ts`, and `timezone-overrides.ts`. Captures the iframe realm's native methods for fallback paths so each realm stays self-contained.
7. Temporal — `Temporal.Now.{timeZoneId,plainDateTimeISO,plainDateISO,plainTimeISO,zonedDateTimeISO}` when available
8. Nested-iframe cascade — iframe-realm copies of `HTMLIFrameElement.prototype.{contentWindow,contentDocument}` getters, `Node.prototype.{appendChild,insertBefore,replaceChild}`, `Element.prototype.{append,prepend,replaceWith,insertAdjacentElement,insertAdjacentHTML}`, the `innerHTML` setter, plus a `MutationObserver` on the iframe's own `documentElement`. This causes a nested iframe created from inside the outer iframe to trigger `patchIframeWindow` on itself recursively — so grand-nested iframes get the same treatment, and so on.
9. Document — `Document.prototype.lastModified` getter override on the iframe's realm
10. RTCPeerConnection — iframe-realm copy of the top-level WebRTC override

Cross-origin iframes throw `SecurityError` on any access and are silently skipped. All shape/descriptor checks in the cascade use tag-name / duck-typing rather than `instanceof`, because elements created in the iframe's realm are not instances of the top-level constructors.

#### temporal.ts

Feature-detected Temporal API overrides. Overrides `Temporal.Now` methods when available:

- `timeZoneId()` — returns spoofed identifier
- `plainDateTimeISO()`, `plainDateISO()`, `plainTimeISO()`, `zonedDateTimeISO()` — pass spoofed identifier when no explicit timezone argument provided

#### worker-patching.ts

Wraps the `Worker` and `SharedWorker` constructors so worker realms receive the spoofing payload. For blob / data / nested workers it prepends `SPOOF_CORE` at construction time (every engine) and recursively wraps `self.Worker` inside each worker so nested workers to any depth are covered. For URL-based workers it announces the URL to the background (`ANNOUNCE_WORKER_FETCH`) and passes the original URL through, so the Firefox `webRequest.filterResponseData` listener can prepend the payload at the network layer. Skipped in cross-origin frame contexts.

#### worker-payload.ts

Defines `SPOOF_CORE` — the self-contained ES5 spoofing payload injected into worker scopes — and `buildStandaloneWorkerPayload(identifier)`, which wraps it in an IIFE with the spoofed IANA id substituted. Shared by both `worker-patching.ts` (content-script path) and `src/background/worker-request-filter.ts` (Firefox `filterResponseData` path) so both paths inject byte-identical behavior. Provides full main-realm parity — `Date` constructor / `Date.parse`, `getTimezoneOffset`, local getters and setters, `getMilliseconds`, the formatter family, `Intl.DateTimeFormat` + `resolvedOptions`, and `Temporal.Now.*` — with `new.target`-aware constructors and, via the `__nativeMethod` concise-method wrapper, native method shape (no `prototype` / `[[Construct]]`, correct `name` / `length` / `[native code]` toString). See [Worker-scope overrides](#worker-scope-overrides-spoof_core).

### Content Script → Injected Script Communication

Uses `CustomEvent` with a configurable event name (`EVENT_NAME`, set at build time, defaults to `"__x_evt"`). CSP-safe.

```typescript
interface SettingsEventDetail {
  enabled: boolean;
  location: Location | null;
  timezone: Timezone | null;
}
```

On Firefox, `cloneInto()` is used to make the detail object accessible across content-script / page-context boundaries.

### Hosted Safari activation handshake

The isolated-world content script also owns a deliberately narrow `window.postMessage`
handshake for the iOS onboarding page. It is active only in the top frame at
`https://geospoof.com/activate` or `https://www.geospoof.com/activate` (an optional
trailing slash and query parameters are allowed). Development-mode Safari bundles also
accept the exact loopback origins `localhost:3000` and `127.0.0.1:3000` over HTTP or
HTTPS so the hosted flow can be exercised locally. Production bundles never enable
those loopback origins.

The page sends a random, per-load nonce:

```typescript
{
  source: "com.geospoof.activation-page";
  type: "GEOSPOOF_ACTIVATION_PING";
  protocolVersion: 1;
  nonce: string;
}
```

The content script responds only after background settings have loaded, protection is
enabled, and a spoofed location exists:

```typescript
{
  source: "com.moonloaf.geospoof.extension";
  type: "GEOSPOOF_ACTIVATION_READY";
  protocolVersion: 1;
  nonce: string;
}
```

Both the page origin and `event.source === window` are checked, and the response is
bound to the request nonce. No coordinates, settings, entitlement, install identifier,
or other user data are sent. Silence is intentionally ambiguous: it can mean the
extension is absent, lacks website access, is blocked by restrictions, is still loading,
or does not currently have protection plus a location enabled. The activation page must
therefore describe silence as “not detected yet,” never as proof that the extension is
disabled.

After Safari returns a spoofed location successfully, the page offers
`geospoof://onboarding/safari-complete`. The iOS `SceneDelegate` routes that URL for both
cold and warm app opens through a process-local, one-shot `AppRouter` request. An active
first-run or debug onboarding flow consumes the request and presents the native
“Safari is ready” screen; users who already completed onboarding simply return to the
app. The custom URL is navigation, not a security attestation—the nonce-bound extension
handshake and successful browser geolocation read are the proof shown by the hosted page.

## Message Types and Payloads

The extension uses `browser.runtime.sendMessage` and `browser.runtime.onMessage` for inter-component communication. All messages follow this structure:

```typescript
{
  type: string,      // Message type identifier
  payload?: object   // Message-specific data
}
```

### Popup → Background Messages

#### SET_LOCATION

```typescript
{ type: "SET_LOCATION", payload: { latitude: number, longitude: number } }
```

Side effects: Calculates timezone (local lookup via browser-geo-tz boundary data fetched from geospoof.com), performs reverse geocoding, saves to storage, broadcasts to all content scripts, updates badge.

#### SET_PROTECTION_STATUS

```typescript
{ type: "SET_PROTECTION_STATUS", payload: { enabled: boolean } }
```

Side effects: Saves status, updates badge (green/gray), broadcasts to content scripts.

#### SET_WEBRTC_PROTECTION

```typescript
{ type: "SET_WEBRTC_PROTECTION", payload: { enabled: boolean } }
```

Side effects: Configures browser privacy API settings, saves to storage.

#### GEOCODE_QUERY

```typescript
{ type: "GEOCODE_QUERY", payload: { query: string } }
```

Response: `{ results: [{ name, latitude, longitude, city, country }] }`
Error: `{ error: "TIMEOUT" | "NETWORK" | "NO_RESULTS", message: string }`

#### GET_SETTINGS

```typescript
{
  type: "GET_SETTINGS";
}
```

Response: Complete settings object.

#### COMPLETE_ONBOARDING

```typescript
{
  type: "COMPLETE_ONBOARDING";
}
```

#### SYNC_VPN

```typescript
{ type: "SYNC_VPN", payload?: { forceRefresh?: boolean } }
```

Detects the public exit IP, geolocates it, applies the location (with timezone hint), and sets `vpnSyncEnabled: true`. Clears per-endpoint cooldowns first so every endpoint gets a fresh shot. `forceRefresh` bypasses caches and in-flight dedup (the Re-sync button).
Response: `{ latitude, longitude, city, country, ip }` or `{ error: "IP_DETECTION_FAILED" | "GEOLOCATION_FAILED" | "IP_BLOCKED" | "NETWORK", message }`. See [VPN_SYNC.md](VPN_SYNC.md).

#### DISABLE_VPN_SYNC

```typescript
{
  type: "DISABLE_VPN_SYNC";
}
```

Clears the IP-geo cache and `lastSyncedIp`, sets `vpnSyncEnabled: false`, and nulls `location` / `timezone` / `locationName`.

#### CLEAR_LOCATION

```typescript
{
  type: "CLEAR_LOCATION";
}
```

Nulls `location` / `timezone` / `locationName` and broadcasts to content scripts.

#### CHECK_TAB_INJECTION

```typescript
{ type: "CHECK_TAB_INJECTION", payload: { tabId: number } }
```

Response: `{ injected: boolean, error: string | null }`.

#### SET_DEBUG_LOGGING / SET_VERBOSITY_LEVEL / SET_THEME

```typescript
{ type: "SET_DEBUG_LOGGING", payload: { enabled: boolean } }
{ type: "SET_VERBOSITY_LEVEL", payload: { level: string } }
{ type: "SET_THEME", payload: { theme: "system" | "light" | "dark" } }
```

#### SAVE_FAVORITE / REMOVE_FAVORITE / RENAME_FAVORITE

```typescript
{ type: "SAVE_FAVORITE", payload: { id, latitude, longitude, city, country, displayName, label } }
{ type: "REMOVE_FAVORITE", payload: { id: string } }
{ type: "RENAME_FAVORITE", payload: { id: string, label: string } }
```

Response: `{ success: true }` or `{ error: "AT_CAPACITY" | "STORAGE_ERROR" }`. Capacity is 50 (`MAX_FAVORITES`); saves dedupe by coordinates rounded to 4 decimal places.

#### SET_PRECISION

```typescript
{ type: "SET_PRECISION", payload: { precision: { mode: "exact" } | { mode: "approximate", radiusMeters: number } } }
```

Repairs the value through `validateLocationPrecision` (unknown mode → exact; radius clamped to 50–50,000 m), persists it, and broadcasts to content scripts.
Response: `{ success: true }` or `{ error: "STORAGE_ERROR" }`.

#### SET_PRECISION_CADENCE

```typescript
{ type: "SET_PRECISION_CADENCE", payload: { cadence: "never" | "session" | "hour" | "day" } }
```

Any other value (including `"page"`) is stored as `"never"` and still returns `{ success: true }`. A non-Never cadence persists a valid `precisionSeed` when none is stored; a valid stored seed is never changed, and `locationPrecision` is never touched. Switching to `hour` or `day` starts from the clock's current bucket; re-selecting the current cadence keeps the held one. After the save it re-registers the Firefox bootstrap, broadcasts, and creates (hour, day) or clears (never, session) the `precision-rollover` alarm. See [Location precision and cadence](#location-precision-and-cadence). Implemented by `applyPrecisionCadence`, which the Safari app bridge also calls.
Response: `{ success: true }`; `{ error: "STORAGE_ERROR" }` when the save fails (nothing changes); or `{ error: message }` when the broadcast fails (the save and the alarm stand).

#### SAVE_SITE_LOCATION / REMOVE_SITE_LOCATION

```typescript
{
  type: "SAVE_SITE_LOCATION",
  payload: {
    id?: string,                          // present when editing; an unknown id saves a new entry
    patterns: string[],                   // host-only patterns; re-parsed and deduped
    latitude: number,
    longitude: number,
    locationName?: LocationName | null,   // omitted or null: keep the stored name when the coordinates are unchanged, else reverse-geocode
    label?: string | null                 // omitted keeps the stored label; null or "" clears it
  }
}
{ type: "REMOVE_SITE_LOCATION", payload: { id: string, pattern?: string } }
```

`SAVE_SITE_LOCATION` validates the coordinates and every pattern (`parseSiteLocationPattern`), rejects a pattern another entry owns and a new entry past the cap, then resolves the time zone. A pattern-only edit keeps the stored zone; a longitude estimate (`fallback: true`) is refused, never stored. Because a concurrent save, VPN resync, or app adoption can land during the lookups, it re-loads settings and re-checks conflicts and capacity before writing. It then broadcasts, re-badges, and re-syncs Chromium's engine-level spoofing; the save itself pushes `REGION_UPDATE` and re-registers the Firefox bootstrap.

`REMOVE_SITE_LOCATION` with a `pattern` removes just that pattern (the popup's "Use main location" for one site of a multi-site entry), and the entry goes with its last pattern. Without one it removes the entry. An unknown id or pattern is a no-op success.

Response: `{ success: true, id: string }` or `{ error: SiteLocationErrorCode, pattern?: string, ownerId?: string }`:

| Error                  | When                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `INVALID_PATTERN`      | A pattern isn't a valid site-location pattern, or the list is empty. `pattern` names the bad one |
| `PATTERN_IN_USE`       | Another entry already has the pattern. `pattern` and `ownerId` name it                           |
| `AT_CAPACITY`          | A new entry would exceed `MAX_SITE_LOCATIONS` (50)                                               |
| `TOO_MANY_PATTERNS`    | More than `MAX_PATTERNS_PER_SITE_LOCATION` (10) distinct patterns                                |
| `INVALID_LOCATION`     | The coordinates aren't finite or are out of range                                                |
| `TIMEZONE_UNAVAILABLE` | The lookup failed or returned only a longitude estimate                                          |
| `STORAGE_ERROR`        | `storage.local.set` rejected                                                                     |

### Content Script → Background Messages

#### ANNOUNCE_WORKER_FETCH

```typescript
{ type: "ANNOUNCE_WORKER_FETCH", payload: { url: string } }
```

Fire-and-forget. Sent by the content-script Worker wrapper just before handing off to the real constructor, so the Firefox `webRequest.filterResponseData` listener knows the next request for `url` is a worker script. Only same-origin worker URLs are allowlisted; cross-origin workers are never patched.

### Background → Content Script Messages

#### UPDATE_SETTINGS

```typescript
{
  type: "UPDATE_SETTINGS",
  payload: {
    enabled: boolean,
    location: { latitude: number, longitude: number, accuracy: number } | null,
    timezone: { identifier: string, offset: number, dstOffset: number } | null,
    debugLogging: boolean,
    verbosityLevel: string,
    webrtcProtection: boolean
  }
}
```

#### PING

```typescript
{
  type: "PING";
}
```

Response: `{ pong: true }` — used for injection health checks via `browser.alarms`.

## Settings Schema

Persisted in `browser.storage.local` under the key `"settings"`.

```typescript
{
  enabled: boolean,
  location: { latitude: number, longitude: number, accuracy: number } | null,
  timezone: { identifier: string, offset: number, dstOffset: number, fallback?: boolean } | null,
  locationName: { city: string, country: string, displayName: string } | null,
  webrtcProtection: boolean,
  onboardingCompleted: boolean,
  vpnSyncEnabled: boolean,          // VPN sync is the active location method
  debugLogging: boolean,            // verbose logging toggle
  verbosityLevel: string,           // debug logger threshold (e.g. "INFO")
  theme: "system" | "light" | "dark",
  favorites: Favorite[],            // up to 50 saved locations
  locationPrecision: { mode: "exact" } | { mode: "approximate", radiusMeters: number },
  precisionSeed: number,            // per-install seed for the approximate offset; 0 = unseeded
  precisionCadence: "never" | "session" | "hour" | "day", // default "never"; bridged to the Safari app as a plain string
  version: string,
  lastUpdated: number,              // epoch ms; default 0 (never-saved sentinel — see app-bridge.ts)
  siteLocations: SiteLocation[]     // default []; see Site locations below
}
```

### Site locations

A site location gives specific sites their own location. It's a second axis next to Site Filters: Filters decide **whether** GeoSpoof is on for a tab, and a site location decides **which** location it reports there. Neither changes the IP address, which is what most services use for region decisions.

**Stored shape** (`SiteLocation` in `src/shared/types/settings.ts`):

```typescript
{
  id: string,                    // Date.now()-style string, at most 64 chars, unique
  kind: "location",              // reserved discriminator; unknown kinds are dropped
  patterns: string[],            // 1–10 canonical host-only patterns, unique across all entries
  location: { latitude, longitude, accuracy },
  timezone: { identifier, offset, dstOffset }, // resolved at save time; never a fallback
  locationName: LocationName | null,
  label: string | null,          // trimmed, at most 100 chars
  updatedAt: number              // epoch ms
}
```

Caps: `MAX_SITE_LOCATIONS = 50` entries and `MAX_PATTERNS_PER_SITE_LOCATION = 10` patterns per entry. Coordinates and zone are a snapshot, so changing the main location or a favorite never moves a site location, and VPN resync updates only the main location. `validateSiteLocations` repairs rather than rejects: an absent field becomes `[]`, an entry failing any rule is dropped whole, and a pattern already claimed by an earlier entry is dropped from the later one.

**Pattern grammar.** The [Site Filters](SITE_FILTERS.md#site-locations) grammar without paths and without a wildcard-only host (`*`, `*://*`, `https://*:8080`). Every accepted pattern is also a valid Filters pattern with the identical canonical form. `tests/fixtures/site-location-vectors.json` pins the accept/reject cases for other implementations.

**Resolution order**, per tab, from the tab's top-level URL (`resolveSiteSettings` in `src/shared/utils/site-locations.ts`):

1. Master switch off → nothing applies.
2. Restricted or host-less URL → nothing applies.
3. Filters (`computeEffectiveEnabled`) decide whether GeoSpoof is on. Out of scope, no site location applies, so an entry's coordinates never reach a page Filters keep GeoSpoof off.
4. The most specific matching site location decides which location applies. No match keeps the main settings, by reference.
5. Per-page transforms (approximate precision, cadence, Reported Language) run on the result.

**Precedence.** Each entry scores the highest specificity among its patterns that match, as the tuple `[labels, subdomainsOnly, scheme, port]` compared left to right: more host labels win, then `*.L` over `L`, then an explicit `http`/`https` over an unset scheme over `*`, then an explicit port. For `https://www.example.com/` that orders `www.example.com` > `*.example.com` > `https://example.com` > `example.com` > `*://example.com` > `*.com`. Ties, which cross-entry uniqueness makes defensive only, go to the higher `updatedAt`, then to the smaller `id` by plain `<`. The result doesn't depend on list order.

**Overlay.** A match replaces exactly `location`, `timezone`, and `locationName`; every other field stays global. Language follows the site location's zone when Reported Language is **Match my location**. Accuracy is resolved when the entry is saved, and approximate precision and cadence then apply to its coordinates as they do to the main location's. The background is the only place this runs, and every consumer (page payloads, the Firefox bootstrap, Firefox workers, Accept-Language, Chromium engine-level spoofing, and the toolbar title) goes through the same resolver, so they can't disagree about a tab. `UpdateSettingsPayload` has no list keys, so neither the list nor any pattern or id ever reaches a page.

**Pro.** On Safari, `proFeaturesBlocked` disables the overlay (`computeEffectiveSiteLocations` returns `[]`), and the popup disables the controls. Firefox and Chromium have no gate.

### Location precision and cadence

Every page-bound builder (the per-tab broadcast in `sendSettingsToTab`, the content-script `GET_SETTINGS` reply, `tabs.onCreated`, the injection-check alarm, and the Firefox bootstrap) is built in one module, `src/background/page-payload.ts`, and gets `location` from one resolver, `resolveCurrentPageLocation` in `src/background/precision-cadence.ts`:

```text
point      = applyPrecisionOffset(anchor, effectivePrecision, periodSeed)
periodSeed = precisionCadence === "never"
           ? precisionSeed
           : derivePeriodSeed(precisionSeed, { cadence, index })
```

`effectivePrecision` is `computeEffectiveLocationPrecision(locationPrecision, proFeaturesBlocked)`, so Exact and the iOS Pro gate return the Anchor under every cadence. Under Never the expression is the pre-cadence one, with no `storage.session` I/O and no alarm. The pure derivation (period seeds, phase, buckets) lives in `src/shared/precision/cadence.ts`.

Period sources:

- **Session**: a random uint32 id in `storage.session` (`cache:precisionCadence:session`), minted the first time it's needed. A failed read uses a per-spawn fallback id and never overwrites the stored one.
- **Hour / day**: the bucket `floor((Date.now() − phase) / P)`, with `P` one hour or one day and a per-install `phase` in `[0, P)` derived from `precisionSeed`. The background holds the current bucket, mirrored in `cache:precisionCadence:bucket` so a service-worker restart keeps it. It advances only in the handler for the one-shot `precision-rollover` alarm, or at a background spawn that finds that alarm more than 2 minutes overdue. When the bucket changes and the point would differ, the handler re-reads settings, broadcasts to every tab, and re-registers the Firefox bootstrap. It then schedules the next boundary, never less than 1 s out.

No session id, phase, or bucket reaches pages, and payload shapes are unchanged. **Every page load** is planned for a later release.

**Safari app bridge.** `precisionCadence` crosses the bridge as its own plain string, never inside `locationPrecision`, whose JSON is unchanged:

- **Extension → app.** `REGION_UPDATE.precisionCadence` carries the stored value after every successful save. The native handler stores it as `region_precisionCadence` verbatim, with no validation or trimming, and leaves the stored value alone when the field is absent or not a string.
- **App → extension.** The app writes `pending_precisionCadence` only once it knows a value, verbatim. The handler relays it as `pending.precisionCadence`.
- **Adoption.** Step 7a of `adoptPendingSnapshot` runs after the `locationPrecision` step, which leaves the cadence alone. It adopts only when the value is a string whose `validatePrecisionCadence` repair differs from the stored value, through `applyPrecisionCadence`, so it has the same side effects as `SET_PRECISION_CADENCE`. An absent key is a no-op, a non-string is ignored, an unknown string (such as `"page"`) repairs to `"never"`, and a failure is logged at WARN while the later steps still run.
- **Only the preference crosses.** The session id, held bucket, phase, and `precisionSeed` never do. A rollover saves nothing, so it sends no `REGION_UPDATE`.
- **Pro.** The app's UI gate is a convenience; `proFeaturesBlocked` is what enforces it, returning the Anchor for a non-Pro user under every cadence.

A widget or Shortcut action restamps the app's snapshot, so the app's last-written cadence can override a newer popup change, as for every bridged setting.

Known limits:

1. **Alarm timing.** Chrome alarms have a 30 s floor and can fire late; alarms missed during sleep fire on wake; a dropped alarm is re-created on the next spawn. Until the rollover runs, every frame keeps the previous point, so a new point arrives at or after its boundary, never before. Where alarms don't fire at all (unverified on iOS Safari), the rollover happens at the first background spawn more than 2 minutes after the boundary.
2. **Rollover race.** A `GET_SETTINGS` reply or push computed just before the advance and delivered after the rollover push leaves that frame on the previous point until the next push or a reload. Every settings change has the same race today.
3. **Firefox bootstrap window.** Documents starting during re-registration can get the previous point (or no bootstrap) inline, then the current one from the async path milliseconds later. A registration persisted across a browser restart can carry the previous period's point until startup re-registers. Both are observable only through an early `watchPosition`, and only with Instant timezone protection on.
4. **Safari `storage.session` lifetime is unverified.** It's expected to survive background unload and clear when Safari quits (on iOS, when iOS terminates Safari). If it behaves differently, that defines what a session is on Safari.
5. **Tabs open across an extension update, reload, or disable/enable** keep their old point until reloaded: their orphaned content scripts get no more pushes. New pages and frames in those tabs use the new session id or the recomputed bucket.
6. **Degraded `storage.session`.** Failed reads or writes fall back to a per-spawn session id or the clock bucket. They fail toward more draws, never toward the Anchor.
7. **Averaging.** Redrawing around a fixed center lets a site average samples back toward it; the error shrinks roughly as radius ÷ √n.
8. **Cached positions.** A `getCurrentPosition` with `maximumAge` right after a rollover can return the previous point from the page's cache, as a real device would.

## Data Models

### Location

```typescript
{ latitude: number, longitude: number, accuracy: number }
```

### Timezone

```typescript
{ identifier: string, offset: number, dstOffset: number, fallback?: boolean }
// identifier: IANA timezone ID (e.g. "America/Los_Angeles")
// offset: Minutes from UTC (e.g. -480 for PST)
// dstOffset: DST offset in minutes
// fallback: true when estimated from longitude (Etc/GMT±N) rather than a real lookup — never persisted
```

### LocationName

```typescript
{ city: string, country: string, displayName: string }
```

### Favorite

```typescript
{
  id: string,            // timestamp-based unique id
  latitude: number,
  longitude: number,
  city: string,
  country: string,
  displayName: string,   // capped at 100 chars
  label: string | null   // user-defined; overrides city when non-empty
}
```

### GeolocationPosition (W3C)

```typescript
{
  coords: {
    latitude: number, longitude: number, accuracy: number,
    altitude: null, altitudeAccuracy: null, heading: null, speed: null
  },
  timestamp: number
}
```

## External API Integration

### Nominatim Geocoding API (OpenStreetMap)

Base URL: `https://nominatim.openstreetmap.org`
Rate Limit: 1 req/sec | Auth: None | Timeout: 5s | Retry: 3x exponential backoff

- Forward geocoding: `/search?q=...&format=json&limit=5&addressdetails=1`
- Reverse geocoding: `/reverse?lat=...&lon=...&format=json&addressdetails=1`
- Caching: In-memory by rounded coordinates (4 decimal places)
- User-Agent: `GeoSpoof-Extension/1.0`

### Offline Timezone Lookup

Uses `browser-geo-tz` npm package for offline coordinate-to-timezone resolution. No external geocoding API calls needed for timezone lookup — the boundary dataset is fetched as a version-scoped static asset from `cdn.geospoof.com/geo-tz/<version>/` (CloudFront over a private S3 bucket, provisioned by the CDK app in `cdk/`; range-requested). See [TIMEZONE_GEO_DATA.md](TIMEZONE_GEO_DATA.md) for hosting, versioning, and the data-update runbook.

`getTimezoneForCoordinates(lat, lng, ianaHint?)` resolves in priority order: (1) the offline `browser-geo-tz` boundary lookup, (2) the optional `ianaHint` — an IANA identifier from the winning geo service on the VPN-sync path, used when the boundary lookup throws or returns nothing, and (3) the crude longitude estimate (`Etc/GMT±N`) as a last resort. The hint is validated by format and guarded with a `try/catch` around `Intl` (it's external/untrusted). Longitude-estimate fallbacks are never cached or persisted, so a transient CDN failure retries on the next call. See [VPN_SYNC.md](VPN_SYNC.md#timezone-hint-resolution) for details.

### VPN Sync IP Geolocation

VPN Sync detects the public (exit) IP and geolocates it to align the spoofed location with the VPN region. The public IP is resolved via a **failover pool** of HTTP IP-echo endpoints (AWS → Cloudflare → Akamai → ipify, first success wins), and geolocation is resolved via a **parallel race** of geo services (first success wins):

| Geo service                   | URL                                        | Notes                                    |
| ----------------------------- | ------------------------------------------ | ---------------------------------------- |
| GeoJS (primary)               | `https://get.geojs.io/v1/ip/geo/{ip}.json` | CORS-friendly, no key; lat/lng strings   |
| FreeIPAPI (fallback #1)       | `https://free.freeipapi.com/api/json/{ip}` |                                          |
| ReallyFreeGeoIP (fallback #2) | `https://reallyfreegeoip.org/json/{ip}`    |                                          |
| ipinfo.io (fallback #3)       | `https://ipinfo.io/{ip}/json`              | Google Cloud network; `loc` is `lat,lng` |

Timeout: 10s (IP detection), 5s per geo service | Retry: 2x exponential backoff | Results cached in `browser.storage.session` and `browser.storage.local` (30 days). Each endpoint pool has independent per-endpoint rate-limit cooldowns, and the spoofed location auto-resyncs when the exit IP changes.

**See [VPN_SYNC.md](VPN_SYNC.md) for the full auto-resync architecture** — IP detection failover, per-endpoint cooldowns, the shared resync gate (debounce / min-interval / switch-settle / circuit breaker / IP-diff), the proxy-change and activity watchers, engine support, and timezone-hint resolution.

## Known Limitations

1. **Web Workers** — Content scripts cannot directly inject into Worker/SharedWorker/ServiceWorker contexts because they run in separate global scopes. The extension takes different paths for different URL schemes to balance protection coverage with site-breakage risk:
   - **URL-based workers** (`new Worker("/foo.js")`, module workers, SharedWorker with a URL, `navigator.serviceWorker.register(url)`) — the content script announces the URL to the background and passes the original URL through to the real constructor. On Firefox the background's `webRequest.filterResponseData` listener prepends the spoofing payload to the response bytes, but **only for workers whose registrable domain (eTLD+1) matches the tab's page origin**. Cross-origin workers — such as Cloudflare Turnstile (`challenges.cloudflare.com`), Stripe (`js.stripe.com`), or any other third-party worker loaded from a different domain — are classified as `"pass"` and left completely unmodified. This is an accepted limitation analogous to the cross-origin iframe limitation: the timezone leak in cross-origin workers is not closed by this extension. On Chromium and Safari nothing listens (the API doesn't exist on those engines) and URL-based workers run unpatched on the injection path — a documented engine limit, not a site-breakage path. **On Chromium this is closed when the user enables the opt-in Engine-level Spoofing mode** (`chrome.debugger` → `Emulation.setTimezoneOverride`), which applies across workers including module/service workers (see [Engine-level Spoofing (Chromium)](#engine-level-spoofing-chromium)); Safari has no equivalent.

   - **Inline workers** (`new Worker(URL.createObjectURL(new Blob([...])))` or `new Worker("data:application/javascript,...")`) — blob-wrapped on every engine. The site already committed to an inline URL and its CSP necessarily allows it, so our replacement blob stays within the same allowance.

   Rewriting URL-based workers to blob URLs is deliberately avoided because blob wrapping fails on strict-CSP origins (breaking the site's worker entirely), shifts `self.location` which breaks relative `fetch`/`import` calls inside the worker, and can't preserve module-worker `import` resolution. The `filterResponseData` path has cleaner failure modes: on the rare site that ships Subresource Integrity on worker scripts, the browser rejects the modified bytes, our `onerror` handler disconnects, the original response serves unmodified, and the site keeps working (with no protection on that origin).

   Where the payload does reach a worker (blob/data/nested on every engine; URL-based/module/service on Firefox), it provides full main-realm parity and native-indistinguishable overrides — see [Worker-scope overrides](#worker-scope-overrides-spoof_core). Every override matches native method shape (no own `prototype`, no `[[Construct]]`, correct `name` / `length` / `[native code]` toString), the `Date` and `Intl.DateTimeFormat` constructors are `new.target`-aware, and CreepJS's `code:` worker-fingerprint hash is closed on Firefox: the payload derives the engine-specific `"[native code]"` surround format at runtime and matches Firefox's multi-line shape, so spoofed `Intl.DateTimeFormat`, `Date` constructor + prototype methods, `Worker`, and `importScripts` all pass the native-shape check.

2. **XSLT/EXSLT datetime (Firefox only) — closed, with edges.** `XSLTProcessor` runs inside a C++ engine (libxslt on Gecko) that doesn't round-trip through JavaScript date machinery, so EXSLT's `date:date-time()` emits an ISO datetime carrying the real system UTC offset, bypassing every Date/Intl/Temporal override — the ground-truth surface arkenfox's TZP uses. The result is still delivered back through the JS `XSLTProcessor` API, so GeoSpoof wraps `transformToFragment` / `transformToDocument` (`src/content/injected/xslt-overrides.ts`), walks the result's text nodes, and rewrites any offset-bearing ISO datetime within ~10s of the current instant into the spoofed zone (the tight "is it now?" gate avoids corrupting legitimate datetimes in transformed content). The iframe patcher installs the same wrap on each same-origin iframe realm's `XSLTProcessor`. Residual edges: cross-origin iframe XSLT can't be reached (see #4). Chromium/WebKit don't ship EXSLT, and Firefox is winding XSLT down behind `dom.xslt.enabled` (FF151+; when off, no EXSLT date is produced and this no-ops), so the surface is shrinking regardless.

3. **Extension initialization race** — Browser extensions install overrides at `document_start`, but spoofing settings arrive asynchronously (typically 50-250ms on cold page loads). A fingerprinting script that reads timezone synchronously in `<head>` can win that race and learn the real zone. This is a fundamental MV3 limitation for the content-script path and requires browser-level fixes to eliminate (see Tor Browser, which patches C++ directly). **On Chromium, the opt-in Engine-level Spoofing mode closes this for the timezone**: it attaches via `webNavigation.onBeforeNavigate` before the document's first script runs (see [Engine-level Spoofing (Chromium)](#engine-level-spoofing-chromium)). Geolocation still uses the injected path on every engine, so its cold-start window remains.

4. **Cross-origin iframes** — `SecurityError` prevents any access from the content script to cross-origin iframes, so `patchIframeWindow` silently skips them. Additionally, the injected script runs in every frame context including cross-origin ones — Worker patching, iframe patching, and DOM insertion wrapping are skipped in cross-origin frame contexts to avoid interfering with third-party scripts (e.g. Cloudflare Turnstile) that perform self-integrity checks and break when their execution environment is modified. Timing side-channels can reveal discrepancies between the parent's spoofed view and the cross-origin iframe's real view.

5. **Timing channels** — A content-script spoofer returns fake positions via `setTimeout` on the JavaScript event loop. Real GPS/Wi-Fi/cell-tower lookups go through browser-internal threads with wider, heavier-tailed latency distributions. A detector with enough samples can fingerprint the artificial bounds (10-50ms floor). Additionally, native `maximumAge` caching serves positions sub-millisecond, while a `setTimeout`-based spoofer cannot emit below its configured delay. Only a browser-native implementation can match real hardware timing signatures.

6. **SharedArrayBuffer timing** — High-resolution timing can fingerprint override execution patterns. Unfixable at the content-script level.

7. **IP geolocation** — Extension does not mask IP address. Fingerprinting scripts cross-check public IP country/region against browser-reported geolocation. Closing this gap requires routing traffic through a VPN exit in the spoofed region (hence the VPN Sync feature).

8. **WebRTC IP leaks** — Without `browser.privacy.network.webRTCIPHandlingPolicy` set to `disable_non_proxied_udp`, WebRTC ICE gathering can expose the real public IP via server-reflexive (srflx) candidates, even when geolocation is spoofed. On Firefox this only holds when behind a proxy/VPN; on Chromium it's strict. Safari doesn't expose `browser.privacy`.

9. **Precision cadence timing** — Under Every hour and Every day the reported point moves while pages are open, at an install-specific time that can be late (alarm scheduling, sleep) but never early, and redrawing gives a site more samples to average. See [Location precision and cadence](#location-precision-and-cadence) for these and the other cadence limits.

10. **Site locations: the Firefox bootstrap is narrower.** Instant timezone protection follows one rule, _the bootstrap may be absent but must never be wrong_ (`planBootstrapScripts` in `src/background/bootstrap-register.ts`). Wherever the userScripts match patterns can't say exactly which pages a value belongs to, no early value is seeded, and those pages get the right one from the async path a few milliseconds later, inside the window described in #3. In practice:
    - With any site location, or with Filters in Allowlist or Denylist mode, only top frames are seeded, never subframes, because userScripts match each frame's own URL while the decision follows the top-level page.
    - A site-location pattern with a port (`example.com:8080`) gets no early seed, and its host is left unseeded on every port.
    - A denylist entry leaves its whole host unseeded on every scheme, port, and path; a denylisted `*` turns the bootstrap off entirely.
    - In Allowlist mode, entries with a path or port seed nothing, and a site location only gets a seed where a path-free, port-free allowlist entry covers all of it.
    - A `*.example.com` site location leaves the apex `example.com` unseeded unless another pattern covers it, and where two site locations' hosts overlap, the broader one doesn't seed the narrower one's host.
    - With no main location, only site-location pages are seeded.

    Chromium and Safari have no bootstrap.

11. **Site locations: Accept-Language on the first request (Chromium, Safari).** When site locations give tabs different languages, the header comes from per-tab `declarativeNetRequest` session rules that are refreshed when a tab starts navigating. The first request of a navigation to a site with a different language can be sent before the refresh lands and carry the previous value. Firefox sets the header per request and has no such race.

12. **Site locations: embedded content follows the page it's in.** Every frame and worker in a tab gets the top-level page's decision. A Twitch player embedded on another site gets that site's location, not Twitch's, and a page embedded inside `twitch.tv` gets Twitch's.

13. **Site locations: some open pages keep old values until reloaded.** A change is pushed to open tabs right away, as for any settings change, but a page restored from the back/forward cache and a worker that's already running keep the values they started with. A value changing under a live page is also a visible discontinuity, so the popup suggests reloading after each change.

## Performance Targets

| Operation                | Target                    |
| ------------------------ | ------------------------- |
| Geolocation API overhead | <50ms per call            |
| Popup open time          | <200ms                    |
| Settings save            | <500ms                    |
| Settings load on startup | <1 second                 |
| Geocoding request        | <5 seconds (with timeout) |
| Badge update             | <100ms                    |

## Browser Compatibility

| Browser               | Minimum Version |
| --------------------- | --------------- |
| Firefox               | 140+ (MV3)      |
| Firefox Android       | 140+            |
| Chrome / Brave / Edge | MV3             |
| Safari (macOS)        | 15+             |
| Safari (iOS / iPadOS) | 15+             |
