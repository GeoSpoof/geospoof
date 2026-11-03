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
> optional **Engine-level Spoofing** mode that also sets the _timezone_ in the
> browser engine through the Chrome DevTools Protocol (`chrome.debugger`), with
> the injected timezone overrides kept as the fallback wherever that doesn't
> reach — see [Engine-level Spoofing (Chromium)](#engine-level-spoofing-chromium).
> It is off by default; geolocation always stays on the injected path.

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
| `Date.prototype.getTimezoneOffset`     | Negated Intl-based offset for spoofed tz; keeps or drops seconds as the browser does ([details](#sub-minute-historical-offsets))           |
| `Date.prototype.toString`              | Formatted with spoofed tz name and offset; offset in whole minutes truncated toward zero, as every engine prints it                        |
| `Date.prototype.toDateString`          | Formatted in spoofed timezone                                                                                                              |
| `Date.prototype.toTimeString`          | Formatted with spoofed offset and tz name; offset in whole minutes truncated toward zero, as every engine prints it                        |
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

### Sub-minute historical offsets

Before a zone adopted standard time its offset was local mean time, which has seconds: Asia/Tokyo was +9:18:59 until 1888 and America/Los_Angeles −7:52:58 until 1883. Browsers disagree on what `getTimezoneOffset()` returns for those dates:

| Engine                     | `getTimezoneOffset()`, 1879 Tokyo | Source                                                                                                                                                                                         |
| -------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SpiderMonkey (Firefox)     | −558.98333… (exact)               | `js/src/jsdate.cpp`; measured on Firefox 159                                                                                                                                                   |
| V8, Chrome 156 and later   | −558.98333… (exact)               | [v8/v8@646e0b7](https://github.com/v8/v8/commit/646e0b706cd01876093bdfb2b6708e853ee30e94), fixing [crbug 40814804](https://issues.chromium.org/issues/40814804); first shipped in 156.0.8078.0 |
| V8, Chrome 155 and earlier | −558 (truncated toward zero)      | Same commit                                                                                                                                                                                    |
| JavaScriptCore (Safari)    | −558 (truncated toward zero)      | WebKit `DatePrototype.cpp` (an `int32` minute offset); measured with macOS's system JavaScriptCore (`jsc`), not yet in Safari itself                                                           |

In all of them the local getters (`getHours` … `getSeconds`) keep the seconds, and `toString` / `toTimeString` print whole minutes truncated toward zero (`GMT+0918`). The override has to return what the browser itself returns. Otherwise `getTimezoneOffset` disagrees with every other method for those dates, and arkenfox TZP's `[offsets] timezone` row reads "mixed".

**How the extension decides.** Engine identity can't tell Chrome 155 from 156, so `state.ts` probes behavior once at load (`nativeFractionalOffset`, logic in `src/shared/native-offset-precision.ts`). It runs before any override is installed and, since the injected script runs at `document_start`, before any page script. It reads the native `getTimezoneOffset` and the native local getters at 1800-01-01 12:00 UTC in the real system zone, when every zone was on local mean time. If the getters show seconds, `getTimezoneOffset` either keeps them or drops them, and the override does the same in the top realm and in every same-origin iframe. The probe makes eight native calls on one `Date` and leaves nothing behind.

**When the real zone has no seconds.** The probe can only see the real zone. With ICU 77, 43 of 428 zone ids have no seconds at the probe instant, nor at any January or July from 1800 to 2000: UTC and `Etc/*`, zones whose history starts at offset 0 (Antarctic and Canadian Arctic stations), and whole-minute local mean time zones such as Europe/Warsaw, Asia/Taipei and Africa/Johannesburg. No in-page surface reveals the precision there, so the extension uses what each engine is known to do:

| Build    | Fallback                                                                                                        |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| Firefox  | Keep the seconds                                                                                                |
| Safari   | Truncate                                                                                                        |
| Chromium | `Chrome/N` in the user agent: 156 or later keep the seconds, 155 or earlier truncate, no token keep the seconds |

What the fallback can get wrong: a user agent that claims a different Chrome major than the real one, and the Chromium build running on an engine that isn't V8, both get the user agent's answer.

**Workers** never probe on their own. The content-script path bakes the page realm's decision into the payload as a literal, so blob, data and nested workers agree with the page. The Firefox `filterResponseData` path builds payloads in the background, which runs the same probe once on its own `Date` (same engine and system zone as the page).

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
| `Date.prototype.getTimezoneOffset`                                                      | Intl-derived spoofed offset; keeps or drops seconds before standard time per the page's decision ([details](#sub-minute-historical-offsets))                                                                                                               |
| `Date.prototype` local getters (`getHours`…`getFullYear`, `getDay`)                     | Read in the spoofed zone                                                                                                                                                                                                                                   |
| `Date.prototype.getMilliseconds`                                                        | Passthrough (timezone-independent); registered for `toString` masking                                                                                                                                                                                      |
| `Date.prototype` local setters (`setHours`…`setFullYear`)                               | Components interpreted in the spoofed zone, DST-refined; round-trip against the spoofed getters                                                                                                                                                            |
| `Date.prototype.{toString,toDateString,toTimeString,toLocale*}`                         | Formatted in the spoofed zone; `GMT±HHMM` offset in whole minutes truncated toward zero                                                                                                                                                                    |
| `Intl.DateTimeFormat` constructor + `resolvedOptions`                                   | `new.target`-aware; injects the spoofed zone when none is explicit                                                                                                                                                                                         |
| `Temporal.Now.{timeZoneId,plainDateTimeISO,plainDateISO,plainTimeISO,zonedDateTimeISO}` | Spoofed identifier / spoofed zone when no explicit arg (feature-detected)                                                                                                                                                                                  |
| `Function.prototype.toString`                                                           | Masks every override as `[native code]`; derives the engine-specific surround format at runtime                                                                                                                                                            |

**Native-method shape fidelity.** Every non-constructor override above is installed through a concise-method wrapper (`__nativeMethod`, the worker-payload twin of the main realm's `stripConstruct`), so it has **no own `prototype` and no `[[Construct]]` slot** — matching native methods, where `new Date.prototype.getHours()` and `Reflect.construct(Date.prototype.getHours, [])` throw `TypeError` — and carries the correct native `name` / `length` / `[native code]` toString. The two real constructors (`Date`, `Intl.DateTimeFormat`) keep their own `prototype` and `[[Construct]]`. Without this, a naive `function(){}` override would carry a `prototype` and be constructable, a worker-side tell distinct from the timezone value.

Not applicable in worker scope (correctly absent): geolocation, permissions, `document.lastModified`, WebRTC, XSLT, iframe / DOM cascade — those APIs don't exist there.

### Document overrides

| API                                        | Override Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Document.prototype.lastModified` (getter) | Reformats the native `"MM/DD/YYYY HH:MM:SS"` string from the real system timezone into the spoofed timezone. Covers `document.lastModified`, `DOMParser`-constructed documents, and `iframe.contentDocument.lastModified` via prototype-level patching. In Engine-level Spoofing (Chromium) Chrome still formats the string in the OS zone while the engine's zone is emulated, so the realm parses it with the OS offset it recovers from a blank document's `lastModified` ("now" in the OS zone); the page never sees the OS zone. A `Last-Modified` header from the other side of an OS DST change then comes back off by the DST delta |

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
implemented in `src/background/debugger-spoof.ts`) that also sets the **timezone**
in the browser engine through the Chrome DevTools Protocol, keeping the
page-world injection as the fallback wherever that doesn't reach.
It exists to narrow two gaps the content-script path cannot cover on Chromium
MV3 (which has no `webRequest.filterResponseData`):

- **Workers** — `Emulation.setTimezoneOverride` sets the zone in the tab's
  renderer process: the page, its same-process iframes, and the workers running
  there, including module workers, so URL-based workers that run unpatched
  under the injection path on Chromium are covered. A cross-origin iframe runs
  in its own process. On Chrome 125+ it's attached as a child session that
  gets the page's zone as soon as it attaches, so the workers it starts get
  the zone, including ones its first script starts, and so do its later reads.
  Its own first `<head>` script can still run before that and read the real
  zone (Known Limitation 4). A frame no session reaches falls back to the
  injected timezone (the "Timezone injection" row below).
- **Cold-start race** — narrowed, not closed. In a tab GeoSpoof already holds,
  a page whose zone is the same as the previous page's runs its first script
  with it. A tab's first page runs its first scripts with the real zone (Known
  Limitation 3), and a page whose zone differs from the previous page's runs
  them with the previous page's zone (Known Limitation 15).

| Aspect             | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trigger            | Opt-in only (`debuggerModeEnabled`); no-op when off, on non-Chromium builds, or when `chrome.debugger` is unavailable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Mechanism          | `chrome.debugger.attach` per in-scope http/https tab, then `Emulation.setTimezoneOverride` with the spoofed IANA id. On Chrome 125+, `Target.setAutoAttach` (flat sessions) attaches each cross-origin iframe, and through it its own cross-origin iframes, as a child session (`src/background/debugger-sessions.ts`), and the zone the tab's root was set to is sent to it as soon as it attaches; each step is bounded to 1 s. New frames aren't paused for it (`waitForDebuggerOnStart: false`): with pausing, Chrome 156 also paused the page's new dedicated workers, and on a page where another extension's frame made Chrome end the session nothing resumed them (every dedicated worker hung in about one load in five)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Early attach       | `webNavigation.onBeforeNavigate` (runtime `webNavigation` permission); falls back to `tabs.onUpdated` when that permission isn't granted. With the permission, the zone is applied again on `onCommitted` (the URL that committed, after any redirects) and `onErrorOccurred` (the page that stays after a download, a 204 or a failed navigation). A tab GeoSpoof already holds isn't attached again                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Scope              | Honors the same per-site all/allowlist/denylist scope as the injection path; out-of-scope or denylisted tabs are detached                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Geolocation        | **Not** handled here — CDP geolocation override races the first `getCurrentPosition` grant, so geolocation stays on the prompt-free injected path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Timezone injection | The payload still carries each page's zone, flagged `engineTimezone`. Each frame compares it with the zone its own engine reports (`engineReportsZone`): where they match, `Date`/`Intl`/`Temporal` stay native and report the zone from the engine; where they don't (a frame no session reaches, a tab Chrome won't attach to, a session that was cancelled or ended, an override that hasn't landed yet), the injected overrides take the zone. The CDP zone (`buildOverridesForTab`) and the payload zone (`buildPagePayload`) come from the same resolver over the same top-level URL, so a frame reports its top-level page's zone either way. The page world gets only the flag, never the real zone. A page Chrome is prerendering gets `engineTimezone: false` and the injected path until it's shown, because the tab's session doesn't reach it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Not covered        | Where a frame falls back to the injected overrides, it has their coverage, not the engine's: its first scripts run before its settings arrive (#3), and the URL workers it starts keep the real zone (#1). A cross-origin iframe's first `<head>` script can run before its child session sets the zone and read the real zone (Known Limitation 4 has the numbers); the workers that script starts got the zone in every load measured. Chrome ends the tab's session when another extension's frame (`chrome-extension://`, as password managers add) appears in the page, and won't attach while the page shows one; GeoSpoof attaches again on the next navigation, so on such a page the engine override usually holds, but sometimes the page uses the injected path (its URL worker had the spoofed zone in 22 of 24 loads with `webNavigation`, 24 of 24 without). Cross-origin iframes before Chrome 125 use the injected path too. Chrome can also run two tabs' cross-origin iframes in one process; the override is per process and the first one set wins, so the second tab's iframe starts its workers in the other tab's zone, while its `Date`/`Intl` report its own page's zone through the injected fallback. `document.lastModified` follows the page's zone (see [Document overrides](#document-overrides)), except that a `Last-Modified` header from the other side of an OS DST change is off by the DST delta (an hour for most zones). Measured in Chrome 156 |
| Teardown           | Reverts explicitly (`setTimezoneOverride` with empty id) on the child sessions and the root, then detaches. When a session ends with its tab still open (the user cancelled the bar, or another extension's frame appeared in the page and Chrome ended it), the tab is sent its settings again, so each frame re-checks whether its engine still reports the page's zone. On a page showing another extension's frame, Chrome keeps the override after ending the session and refuses both the revert and a new attach while the frame is shown ("Cannot access a chrome-extension:// URL of different extension"). So turning protection off or excluding the site reaches that page only at its next navigation or reload; until then the page and the workers it starts keep the spoofed zone. After turning the mode off, only those workers keep the engine zone; the page's `Date`/`Intl` report the same zone through the injected path, as they should. Measured in Chrome 156 on both attach paths; on a page without such a frame every change took effect at once                                                                                                                                                                                                                                                                                                                                                                                                           |
| Permission         | `debugger` is declared **required** (Chrome forbids it in `optional_permissions`) but maps to the existing "access your data on all websites" warning, so it adds no new install prompt. Chrome shows a "GeoSpoof started debugging this browser" bar only while the mode is actually attached                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| State              | In memory: which tabs GeoSpoof holds, the zone each was set to, their child sessions, and a number for each tab's newest reconcile (`TabSessionTracker`). A navigation (start, commit, abort, same-document), a settings change and a teardown each start a reconcile when their event arrives (a settings change before it lists the tabs, so a tab that navigates meanwhile keeps the navigation's zone); an older one sends nothing once a newer one has started, so the newest is the last to write whichever settings read or tab list finishes first. A child session gets the zone the newest reconcile set on the root as soon as it attaches, with no lookup, and that reconcile's own pass over the children overwrites it in order. An attached session keeps the service worker alive (Chrome 118+); after a forced restart, a held tab's child sessions are rediscovered by turning auto-attach off and on. `chrome.debugger.getTargets()` stays the source of truth for which tabs are attached; settings are read fresh per event                                                                                                                                                                                                                                                                                                                                                                                                                                        |

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
- `nativeFractionalOffset` — whether native `getTimezoneOffset` keeps the seconds of a pre-standard-time offset, probed from the originals at load ([Sub-minute historical offsets](#sub-minute-historical-offsets)); drives the `getTimezoneOffset` override and is baked into worker payloads
- `componentsViaShortOffset` — which path the local getters and `toString` family use to derive local time (epoch shift by the Intl shortOffset on V8 / JavaScriptCore, `formatToParts` on SpiderMonkey); keyed on the SpiderMonkey-only `InternalError` global, and independent of `getTimezoneOffset` precision
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
- `formatGMTOffset(offsetMinutes)` — Convert offset to `GMT±HHMM` string, in whole minutes truncated toward zero as every engine prints it
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

The override parses the native `"MM/DD/YYYY HH:MM:SS"` string (which is in the real system timezone), recovers the UTC epoch, and reformats it in the spoofed timezone using `Intl.DateTimeFormat` via `formatToParts`. In Engine-level Spoofing it also runs where the engine owns Date/Intl (`engineTimezoneData`), and `lastModifiedEpoch` parses with the OS offset read from a blank document whenever the engine's offset differs from it.

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

Defines `SPOOF_CORE` — the self-contained ES5 spoofing payload injected into worker scopes — and `buildStandaloneWorkerPayload(identifier, locale, fractionalOffset)`, which wraps it in an IIFE with the spoofed IANA id, the locale, and the `getTimezoneOffset` precision decision ([Sub-minute historical offsets](#sub-minute-historical-offsets)) substituted. Shared by both `worker-patching.ts` (content-script path) and `src/background/worker-request-filter.ts` (Firefox `filterResponseData` path) so both paths inject byte-identical behavior. Provides full main-realm parity — `Date` constructor / `Date.parse`, `getTimezoneOffset`, local getters and setters, `getMilliseconds`, the formatter family, `Intl.DateTimeFormat` + `resolvedOptions`, and `Temporal.Now.*` — with `new.target`-aware constructors and, via the `__nativeMethod` concise-method wrapper, native method shape (no `prototype` / `[[Construct]]`, correct `name` / `length` / `[native code]` toString). See [Worker-scope overrides](#worker-scope-overrides-spoof_core).

### Content Script → Injected Script Communication

Uses `CustomEvent` with a configurable event name (`EVENT_NAME`, set at build time, defaults to `"__x_evt"`). CSP-safe.

```typescript
interface SettingsEventDetail {
  enabled: boolean;
  location: Location | null;
  timezone: Timezone | null;
  engineTimezone?: boolean; // Engine-level Spoofing: keep native Date/Intl where the engine reports `timezone`
}
```

On Firefox, `cloneInto()` is used to make the detail object accessible across content-script / page-context boundaries.

The [settings revision](#settings-revision) that pushes and `GET_SETTINGS` replies carry stays in the content script; it's never part of the event detail.

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

Side effects: Calculates timezone (local lookup via browser-geo-tz boundary data fetched from geospoof.com), performs reverse geocoding, saves to storage, broadcasts to all content scripts, updates badge. The automatic VPN syncs (startup and auto-resync) store their location only if VPN sync is still on when the write runs, so a manual location set during their network calls is kept.

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
  payload?: { topFrame?: boolean }; // content scripts: window.top === window
}
```

Response depends on the sender:

- **Extension pages** (the popup, including the popup opened as a tab on Android) get the complete `Settings` object.
- **Content scripts** get the `UpdateSettingsPayload` for their top-level page, with no list keys. The top-level URL is `topLevelUrlForSender` in `src/background/sender-page-url.ts`: a top-level document is judged by its own URL (`sender.url`), and a subframe by its tab's (`sender.tab.url`). A document counts as top-level when `sender.frameId === 0`, or when it's prerendering (`documentLifecycle: "prerender"`, Chrome) and sent `topFrame: true`, because a prerendered page's outermost frame has a non-zero `frameId`. For the active top frame, a same-origin `tab.url` wins, since Firefox fixes `sender.url` when the content script starts and a History API navigation can't leave the origin. A missing `sender.url` falls back to `tab.url`. A subframe of a prerendering document, or a prerendering document with no `sender.url`, can't name its top-level page, so it follows `tab.url` for Filters and the main location but gets no per-site location (`isUndeterminedPrerenderedFrame`, [Known Limitation 14](#known-limitations)). The toolbar badge and title always follow `tab.url`, the page the user sees. With Engine-level Spoofing on, the reply sets `engineTimezone: true` as the broadcast does, except to a prerendering document, which the tab's debugger session doesn't reach.

Content scripts send it at `document_start`, again when a page is restored from the back/forward cache (`pageshow` with `persisted`), and once when a prerendered page is shown (`prerenderingchange`, Chrome). The reply to a content script also carries `revision`, the [settings revision](#settings-revision) it was built from. A content script applies a reply only if it sent no newer request since, and the reply's revision isn't lower than one it has already applied.

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

Detects the public exit IP, geolocates it, applies the location (with timezone hint), and stores the location and `vpnSyncEnabled: true` in one write. Clears per-endpoint cooldowns first so every endpoint gets a fresh shot. `forceRefresh` bypasses caches and in-flight dedup (the Re-sync button).
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

Response: `{ success: true }` or `{ error: "AT_CAPACITY" | "STORAGE_ERROR" }`. Capacity is 50 (`MAX_FAVORITES`); saves dedupe by coordinates rounded to 4 decimal places. Each runs as one settings write (load, change and save together), so overlapping changes don't lose each other.

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

`SAVE_SITE_LOCATION` validates the coordinates and every pattern (`parseSiteLocationPattern`), rejects a pattern another entry owns and a new entry past the cap, then resolves the time zone. A pattern-only edit keeps the stored zone; a longitude estimate (`fallback: true`) is refused, never stored. Because a concurrent save, VPN resync, or app adoption can land during the lookups, it re-loads settings and re-checks conflicts and capacity before writing. It then broadcasts, re-badges, and re-syncs Chromium's engine-level spoofing; the save itself pushes `REGION_UPDATE` and re-registers the Firefox bootstrap. Both handlers deliver this way, and because the change is already stored by then, a delivery step that fails (for example `tabs.query` rejecting) is logged, the other steps still run, and the response is still success.

`REMOVE_SITE_LOCATION` with a `pattern` removes just that pattern (the popup's "Use main location" for one site of a multi-site entry), and the entry goes with its last pattern. Without one it removes the entry. An unknown id or pattern is a no-op success. The popup offers "Use main location" only when removing the winning pattern changes just this site and leaves it on the main location: a main location is set (`settings.location` isn't null), the pattern is the site's own (its identity is the host's or `suggestSiteLocationPattern`'s), and with it removed `resolveSiteSettings` gives the page no site location. Otherwise the Main-tab line shows only Edit.

Both handlers and the Safari bridge's adoption write the list through one queue (`src/background/site-location-queue.ts`). A save's re-load, re-check, write, and delivery run as one job, a remove runs entirely as one, and so does adoption's load and write. Two overlapping changes therefore can't both read the same list and have the later write erase the earlier one. The time-zone and place-name lookups run outside the queue, so a save that changes coordinates can reach the queue after a remove or save sent later. Each save and remove is therefore stamped with its arrival time in milliseconds, and a save whose entry was already written by a later-stamped remove or save writes nothing and returns `SUPERSEDED`: the later user action wins. A save sent after a remove still wins over it, and recreates the entry. On Safari, an app snapshot that changes or removes an entry stamps it with the snapshot's `updatedAt`, never later than the moment it's adopted. A save still on its lookups that arrived before the app's action then returns `SUPERSEDED`, and one that arrived after it still wins. A save sent after the adoption always wins, even if the device clock steps back. Removes are never superseded. While a save is in flight, the popup also disables that entry's ✕ and "Use main location", so only another popup can send such a remove. Underneath, every settings write goes through `updateSettings` or `updateSettingsWith`, which load, merge, and save the whole settings object one write at a time (`runSettingsWrite` in `src/background/settings.ts`), and the startup migration's save runs the same way. So a write to another field, such as a VPN resync's location or an app adoption's Filters, can't restore an older list, and a list write can't drop that field.

Response: `{ success: true, id: string }` or `{ error: SiteLocationErrorCode, pattern?: string, ownerId?: string }`:

| Error                  | When                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `INVALID_PATTERN`      | A pattern isn't a valid site-location pattern, or the list is empty. `pattern` names the bad one                       |
| `PATTERN_IN_USE`       | Another entry already has the pattern. `pattern` and `ownerId` name it                                                 |
| `AT_CAPACITY`          | A new entry would exceed `MAX_SITE_LOCATIONS` (50)                                                                     |
| `TOO_MANY_PATTERNS`    | More than `MAX_PATTERNS_PER_SITE_LOCATION` (10) distinct patterns                                                      |
| `INVALID_LOCATION`     | The coordinates aren't finite or are out of range                                                                      |
| `TIMEZONE_UNAVAILABLE` | The lookup failed or returned only a longitude estimate                                                                |
| `STORAGE_ERROR`        | `storage.local.set` rejected                                                                                           |
| `SUPERSEDED`           | Save only: a remove or save of the same entry sent later, or a newer app change, was written first. Nothing is written |

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
    engineTimezone: boolean, // Engine-level Spoofing (Chromium) sets `timezone` in the engine
    debugLogging: boolean,
    verbosityLevel: string,
    webrtcProtection: boolean
  },
  revision: number // settings revision the payload was built from; on the envelope, not in the payload
}
```

`revision` is the [settings revision](#settings-revision) of the snapshot the payload was built from. The content script drops a push whose revision is lower than one it has already applied, and applies one that's equal or missing.

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
  revision: number,                 // strictly increasing per save; never bridged or sent to pages
  siteLocations: SiteLocation[]     // default []; see Per-site locations below
}
```

### Settings revision

`revision` orders the settings snapshots that reach pages, so a delivery built before a change can't undo that change. It's extension-internal.

- **Issued per save.** Every save runs inside the serialized settings write and stores `max(Date.now(), previous + 1)`. `previous` is the higher of the stored revision and the highest revision this background has read or issued since it started, so two saves in one millisecond, a clock set back, or a background restart still get a higher revision. At `Number.MAX_SAFE_INTEGER` it stops increasing instead of overflowing, and later saves store the same value. Only the save sets it: `updateSettings` and `updateSettingsWith` ignore a `revision` in their updates. Settings stored before the field existed load as revision 0.
- **Carried on every page delivery.** The `UPDATE_SETTINGS` envelope (outside `payload`) and a content script's `GET_SETTINGS` reply carry the revision of the snapshot they were built from. Every push goes through `sendSettingsToTab`, including the injection-check alarm's and the `tabs.onCreated` push.
- **Content script rule.** A content script drops a delivery whose revision is lower than the highest one it has applied. An equal revision applies, because a precision rollover, a navigation or a tab event often re-sends the same settings. A missing or invalid one applies too, and doesn't change the revision the page has recorded. A page that has applied nothing drops nothing. A delivery built from a failed settings read (the defaults, revision 0) is therefore dropped by a page that has applied real settings.
- **Cache and bootstrap rule.** The worker-filter cache, the Accept-Language snapshot and the Firefox bootstrap registration skip a snapshot older than the newest one they've taken. A navigation still needs its Accept-Language re-plan, so it uses the newer of the cached snapshot and its own. These marks live in background memory and reset when the background restarts.
- **A failed save restores it.** When the write fails, the object's `revision` goes back to its previous value. A caller that keeps the object (startup does after a failed migration save) therefore never delivers a revision that isn't stored.
- **Never bridged, never sent to pages.** `REGION_UPDATE` doesn't carry it. `lastUpdated` stays the save's `Date.now()`, and it's what the Safari bridge compares. The revision stays in the content script's isolated world: the event detail, the Firefox bootstrap payload and the worker payloads don't include it.

**The one way it can go backwards.** It takes all three of these:

1. The save's previous revision isn't the latest stored one. Either the stored `settings` value was lost or replaced by one without a valid revision (cleared storage, a corrupt value, or a Safari quota retry whose remove succeeded and whose second write failed), or the settings read inside the save's write failed.
2. The background restarted after that revision was stored and hasn't read settings successfully since. The read every background spawn makes in `index.ts` counts, so it must also have failed, or have run before storage lost the value.
3. The clock at that save is at or behind the last revision: it was set back, or more than one save per millisecond was sustained right before the restart.

Pages that applied the old revision then drop deliveries until they reload or navigate (a new content script has applied nothing), or until the clock passes that revision. The caches and the bootstrap aren't affected, because the restart reset them.

**Same-document navigation across an unrelated save.** A History API navigation pushes the new route's Filters and site-location decision, built from settings read at that moment. If a save that doesn't broadcast (favorites, theme, UI language, onboarding, the Safari app's `autoSyncBlocked` or favorites) lands between that read and the read for a `GET_SETTINGS` reply built for the old URL, and the reply arrives first, the route push carries the lower revision and is dropped. The page keeps the previous route's decision until the next push or navigation. This needs path-scoped patterns, an early `replaceState` and an unrelated save in that gap.

### Per-site locations

Per-site locations (`siteLocations`) give specific sites their own location. They're a second axis next to Site Filters: Filters decide **whether** GeoSpoof is on for a tab, and a matching entry (a `SiteLocation`, "site location" below) decides **which** location it reports there. Neither changes the IP address, which is what most services use for region decisions.

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

**Pattern grammar.** The [Site Filters](SITE_FILTERS.md#per-site-locations) grammar without paths and without a wildcard-only host (`*`, `*://*`, `https://*:8080`). Every accepted pattern is also a valid Filters pattern with the identical canonical form. `tests/fixtures/site-location-vectors.json` pins the accept/reject cases for other implementations.

**Pattern identity.** Uniqueness, within an entry and across entries, compares `siteLocationPatternKey`: the canonical pattern with its literal host converted to its A-label, as the compiler converts it (`hostToASCII`; an IPv4 host stays as is). The canonical form keeps a Unicode host, so `münchen.de` and `xn--mnchen-3ya.de` are stored as different strings, but they match the same pages with the same specificity and have one key. Only one of them can be stored: the save path dedupes them within an entry and answers `PATTERN_IN_USE` across entries, and `validateSiteLocations` keeps the first. A pattern whose host has no A-label form (`xn--zz.com`) never matches a page, so a save rejects it as `INVALID_PATTERN` and the loader drops it.

**Resolution order**, per tab, from the tab's top-level URL (`resolveSiteSettings` in `src/shared/utils/site-locations.ts`). For a content script's `GET_SETTINGS`, a top-level document supplies its own URL, so a page Chrome is prerendering is judged as the page it will show (see [GET_SETTINGS](#get_settings)):

1. Master switch off → nothing applies.
2. Restricted or host-less URL → nothing applies.
3. Filters (`computeEffectiveEnabled`) decide whether GeoSpoof is on. Out of scope, no site location applies, so an entry's coordinates never reach a page Filters keep GeoSpoof off.
4. The most specific matching site location decides which location applies. No match keeps the main settings, by reference.
5. Per-page transforms (approximate precision, cadence, Reported Language) run on the result.

**Precedence.** Each entry scores the highest specificity among its patterns that match, as the tuple `[labels, subdomainsOnly, scheme, port]` compared left to right: more host labels win, then `*.L` over `L`, then an explicit `http`/`https` over an unset scheme over `*`, then an explicit port. For `https://www.example.com/` that orders `www.example.com` > `*.example.com` > `https://example.com` > `example.com` > `*://example.com` > `*.com`. Ties, which cross-entry uniqueness makes defensive only, go to the higher `updatedAt`, then to the smaller `id` by plain `<`. The result doesn't depend on list order.

**Overlay.** A match replaces exactly `location`, `timezone`, and `locationName`; every other field stays global. Language follows the site location's zone when Reported Language is **Match my location**. Accuracy is resolved when the entry is saved, and approximate precision and cadence then apply to its coordinates as they do to the main location's. The background is the only place this runs, and every consumer (page payloads, the Firefox bootstrap, Firefox workers, Accept-Language, Chromium engine-level spoofing, and the toolbar title) goes through the same resolver, so they resolve a tab the same way, within the limits listed under [Known Limitations](#known-limitations); see Known Limitation #11 for the Accept-Language header. `UpdateSettingsPayload` has no list keys, so neither the list nor any pattern or id ever reaches a page.

**Pro.** On Safari, `proFeaturesBlocked` disables the overlay (`computeEffectiveSiteLocations` returns `[]`), and the popup disables the controls. Firefox and Chromium have no gate. The gate applies when a payload is built, so when step 1c of `adoptPendingSnapshot` adopts a changed `proFeaturesBlocked` it broadcasts (which refreshes Accept-Language too) and re-badges: an open matching page drops its per-site values on a lapse and gets them back on a renewal without a reload, even when the list itself is unchanged.

**Safari app bridge.** The list crosses the bridge as one JSON string, like `favorites`. The extension half ships first and stays inert until the app learns the keys:

- **Extension → app.** `REGION_UPDATE.siteLocations` carries `JSON.stringify(settings.siteLocations)` after every successful save, as the last key. The native handler stores it as `region_siteLocations` verbatim; an older handler drops the unknown key.
- **App → extension.** The app writes `pending_siteLocations`, relayed as `pending.siteLocations`, only once it has read `region_siteLocations` or the user edited the list in the app. Until then it leaves the key unset, because `[]` means "clear the list".
- **Adoption.** Step 9 of `adoptPendingSnapshot` runs after step 8 in its own try/catch. An absent key is a no-op, and invalid JSON or a non-array is ignored, never a wipe. An empty array is adopted as a clear. A bare IANA id in place of a `timezone` object (or an object with non-finite offsets) is repaired with `computeOffsets`. Every zone id is checked against the engine's time-zone data, offsets or not, and an entry whose id the engine can't resolve, or whose zone is marked `fallback`, is dropped. Then every entry is re-validated by `validateSiteLocations`, so invalid entries are dropped. An unchanged list saves nothing; a changed one is saved, broadcast, and badged. The load and write run in the site-location queue. If a save or remove in the extension was written after the snapshot passed its newer-than check, that edit is newer, so the snapshot's list isn't adopted; the edit's own `REGION_UPDATE` carries the list back to the app. Among snapshots that pass the newer-than check, the newest action on an entry wins between the app and the popup, by the snapshot's `updatedAt` against the popup save's arrival time (see `SAVE_SITE_LOCATION`); a save or remove written after the check still wins, as above. Adoptions can overlap (boot, tab switch, navigation, and each Safari `GET_SETTINGS` start one), so the bridge also remembers the newest snapshot with a list that passed its check. An older snapshot that reaches this step after it, for example because it waited on a main-location lookup, doesn't adopt its list, so the newer list stays. The same snapshot adopted twice still applies.
- **Region request (`regionWanted`).** While the app has no current list (no `region_siteLocations` string, or a `region_siteLocationsAt` that's absent or older than `region_updatedAt`), the native handler adds `regionWanted: true` to its `GET_PENDING_SETTINGS` response, often next to `pending: null`. It's a response field, not an App Group key. Only the handler writes it, and only `adoptPendingResponse` reads it; `REGION_WANTED_FIELD` in `app-bridge.ts` holds the literal. The extension reads the flag before the no-snapshot return, then runs adoption and waits for it. If that pass saved nothing (`lastUpdated` unchanged), it sends one `REGION_UPDATE` built from the stored settings. If it saved, the save already pushed. If either settings read throws, it sends nothing, so a storage error can't hand the app the defaults' empty list as Safari's, and a later call that still sees the flag pushes. The push is single-flight: a call that sees the flag while a push is in flight sends nothing, and once the push settles, a call that still sees the flag pushes again. Any value but `true` does nothing. A push that isn't a save carries the stored list. Normally that list is at least as new as the pass's snapshot: the snapshot lost by last-writer-wins, or its list was already stored. The exception is a snapshot whose step 9 deferred to a newer snapshot still in flight (see Adoption). Its pass pushes Safari's list from before both snapshots, and the newer snapshot's save follows with the adopted list. Until that save lands, `region_updatedAt` is newer than the app's `app_siteLocationsEditedAt`, so a `writePending` in that window prunes `pending_siteLocations`, and the app reads the older list as Safari's. The newer pass adopts from the snapshot it already holds, so the app's edit is lost only if the background also stops inside that window. A save in steps 1–8 of any pass opens the same window, because its push carries the list from before step 9. An older handler never sends the field. No settings field or schema version changed, so an upgrade's first boot still doesn't save.
- **Swift must preserve unknown fields and kinds verbatim**, so an entry shape or `kind` added later survives an app round trip. The app mirrors `MAX_SITE_LOCATIONS` (50) and `MAX_PATTERNS_PER_SITE_LOCATION` (10), and validates patterns against `tests/fixtures/site-location-vectors.json`. A native conflict check has to compare patterns by the identity above (the literal host's A-label, UTS #46 ToASCII), not by stored string, or it accepts `münchen.de` next to `xn--mnchen-3ya.de` and the extension drops the later one on adoption. The fixture has no alias cases yet.
- **Pro.** The app's UI gate is a convenience; `proFeaturesBlocked` is what enforces it, disabling the overlay for a non-Pro user while the stored list is kept.

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
2. **Rollover race.** A rollover saves nothing, so its push carries the same settings revision as the deliveries before it. A `GET_SETTINGS` reply or push computed just before the advance and delivered after the rollover push still applies, and leaves that frame on the previous point until the next push or a reload. Settings changes don't race this way: a page drops a delivery built from older settings than one it has applied (see [Settings revision](#settings-revision)).
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
   - **URL-based workers** (`new Worker("/foo.js")`, module workers, SharedWorker with a URL, `navigator.serviceWorker.register(url)`) — the content script announces the URL to the background and passes the original URL through to the real constructor. On Firefox the background's `webRequest.filterResponseData` listener prepends the spoofing payload to the response bytes, but **only for workers whose registrable domain (eTLD+1) matches the tab's page origin**. Cross-origin workers — such as Cloudflare Turnstile (`challenges.cloudflare.com`), Stripe (`js.stripe.com`), or any other third-party worker loaded from a different domain — are classified as `"pass"` and left completely unmodified. This is an accepted limitation analogous to the cross-origin iframe limitation: the timezone leak in cross-origin workers is not closed by this extension. On Chromium and Safari nothing listens (the API doesn't exist on those engines) and URL-based workers run unpatched on the injection path — a documented engine limit, not a site-breakage path. **On Chromium this is closed for the page's own workers when the user enables the opt-in Engine-level Spoofing mode** (`chrome.debugger` → `Emulation.setTimezoneOverride`), which applies to the workers in the page's process, including module workers, and on Chrome 125+ to the dedicated workers a cross-origin iframe starts, through that iframe's child session. It still misses a worker in a process no session reaches: a service worker or SharedWorker Chrome runs in a process of its own, and, before Chrome 125, the workers of cross-origin iframes. Where Chrome runs two tabs' cross-origin iframes in one process, their workers get the zone set first (see [Engine-level Spoofing (Chromium)](#engine-level-spoofing-chromium)); Safari has no equivalent.

   - **Inline workers** (`new Worker(URL.createObjectURL(new Blob([...])))` or `new Worker("data:application/javascript,...")`) — blob-wrapped on every engine. The site already committed to an inline URL and its CSP necessarily allows it, so our replacement blob stays within the same allowance.

   Rewriting URL-based workers to blob URLs is deliberately avoided because blob wrapping fails on strict-CSP origins (breaking the site's worker entirely), shifts `self.location` which breaks relative `fetch`/`import` calls inside the worker, and can't preserve module-worker `import` resolution. The `filterResponseData` path has cleaner failure modes: on the rare site that ships Subresource Integrity on worker scripts, the browser rejects the modified bytes, our `onerror` handler disconnects, the original response serves unmodified, and the site keeps working (with no protection on that origin).

   Where the payload does reach a worker (blob/data/nested on every engine; URL-based/module/service on Firefox), it provides full main-realm parity and native-indistinguishable overrides — see [Worker-scope overrides](#worker-scope-overrides-spoof_core). Every override matches native method shape (no own `prototype`, no `[[Construct]]`, correct `name` / `length` / `[native code]` toString), the `Date` and `Intl.DateTimeFormat` constructors are `new.target`-aware, and CreepJS's `code:` worker-fingerprint hash is closed on Firefox: the payload derives the engine-specific `"[native code]"` surround format at runtime and matches Firefox's multi-line shape, so spoofed `Intl.DateTimeFormat`, `Date` constructor + prototype methods, `Worker`, and `importScripts` all pass the native-shape check.

2. **XSLT/EXSLT datetime (Firefox only) — closed, with edges.** `XSLTProcessor` runs inside a C++ engine (libxslt on Gecko) that doesn't round-trip through JavaScript date machinery, so EXSLT's `date:date-time()` emits an ISO datetime carrying the real system UTC offset, bypassing every Date/Intl/Temporal override — the ground-truth surface arkenfox's TZP uses. The result is still delivered back through the JS `XSLTProcessor` API, so GeoSpoof wraps `transformToFragment` / `transformToDocument` (`src/content/injected/xslt-overrides.ts`), walks the result's text nodes, and rewrites any offset-bearing ISO datetime within ~10s of the current instant into the spoofed zone (the tight "is it now?" gate avoids corrupting legitimate datetimes in transformed content). The iframe patcher installs the same wrap on each same-origin iframe realm's `XSLTProcessor`. Residual edges: cross-origin iframe XSLT can't be reached (see #4). Chromium/WebKit don't ship EXSLT, and Firefox is winding XSLT down behind `dom.xslt.enabled` (FF151+; when off, no EXSLT date is produced and this no-ops), so the surface is shrinking regardless.

3. **Extension initialization race** — Browser extensions install overrides at `document_start`, but spoofing settings arrive asynchronously (typically 50-250ms on cold page loads). A fingerprinting script that reads timezone synchronously in `<head>` can win that race and learn the real zone. This is a fundamental MV3 limitation for the content-script path and requires browser-level fixes to eliminate (see Tor Browser, which patches C++ directly). **On Chromium, the opt-in Engine-level Spoofing mode narrows this for the timezone** in a tab it already holds, where a page with the same zone as the page before it runs its first script with that zone. It doesn't for a tab's first page: in Chrome 156, a page opened straight in a new tab read the real zone in its first `<head>` script 20 times out of 20, on both attach paths, and its later reads were spoofed (see [Engine-level Spoofing (Chromium)](#engine-level-spoofing-chromium); #15 is the cross-site case). Geolocation still uses the injected path on every engine, so its cold-start window remains.

4. **Cross-origin iframes** — `SecurityError` prevents any access from the content script to cross-origin iframes, so `patchIframeWindow` silently skips them. Additionally, the injected script runs in every frame context including cross-origin ones — Worker patching, iframe patching, and DOM insertion wrapping are skipped in cross-origin frame contexts to avoid interfering with third-party scripts (e.g. Cloudflare Turnstile) that perform self-integrity checks and break when their execution environment is modified. Timing side-channels can reveal discrepancies between the parent's spoofed view and the cross-origin iframe's real view. With Engine-level Spoofing on (Chrome 125+), a cross-origin iframe in its own process gets a child debugger session that sets the page's zone in its process as soon as it attaches, so the workers it starts, including ones its first script starts, and its later reads report the page's zone. Its first `<head>` script can run before that and read the real zone: in Chrome 156, over two runs, it did in 44 of 60 reloads on the `tabs.onUpdated` path and 32 of 60 with `webNavigation` (the rate varies from run to run), while a URL worker and a blob worker started by that same script read the page's zone in all 120 loads. Its `Date`/`Intl` report the page's zone once its settings arrive through the injected timezone, as with the mode off. Where the session can't set the zone, its workers keep the zone its process has: the real zone before Chrome 125, or another tab's zone when Chrome runs both tabs' iframes in one process and that tab's override came first (#1, #3).

5. **Timing channels** — A content-script spoofer returns fake positions via `setTimeout` on the JavaScript event loop. Real GPS/Wi-Fi/cell-tower lookups go through browser-internal threads with wider, heavier-tailed latency distributions. A detector with enough samples can fingerprint the artificial bounds (10-50ms floor). Additionally, native `maximumAge` caching serves positions sub-millisecond, while a `setTimeout`-based spoofer cannot emit below its configured delay. Only a browser-native implementation can match real hardware timing signatures.

6. **SharedArrayBuffer timing** — High-resolution timing can fingerprint override execution patterns. Unfixable at the content-script level.

7. **IP geolocation** — Extension does not mask IP address. Fingerprinting scripts cross-check public IP country/region against browser-reported geolocation. Closing this gap requires routing traffic through a VPN exit in the spoofed region (hence the VPN Sync feature).

8. **WebRTC IP leaks** — Without `browser.privacy.network.webRTCIPHandlingPolicy` set to `disable_non_proxied_udp`, WebRTC ICE gathering can expose the real public IP via server-reflexive (srflx) candidates, even when geolocation is spoofed. On Firefox this only holds when behind a proxy/VPN; on Chromium it's strict. Safari doesn't expose `browser.privacy`.

9. **Precision cadence timing** — Under Every hour and Every day the reported point moves while pages are open, at an install-specific time that can be late (alarm scheduling, sleep) but never early, and redrawing gives a site more samples to average. See [Location precision and cadence](#location-precision-and-cadence) for these and the other cadence limits.

10. **Per-site locations: the Firefox bootstrap is narrower.** Instant timezone protection follows one rule, _the bootstrap may be absent but must never be wrong_ (`planBootstrapScripts` in `src/background/bootstrap-register.ts`). Wherever the userScripts match patterns can't say exactly which pages a value belongs to, no early value is seeded, and those pages get the right one from the async path a few milliseconds later, inside the window described in #3. In practice:
    - With any site location, or with Filters in Allowlist or Denylist mode, only top frames are seeded, never subframes, because userScripts match each frame's own URL while the decision follows the top-level page.
    - A site-location pattern with a port (`example.com:8080`) gets no early seed, and its host is left unseeded on every port.
    - A denylist entry leaves its whole host unseeded on every scheme, port, and path; a denylisted `*` turns the bootstrap off entirely.
    - In Allowlist mode, entries with a path or port seed nothing, and a site location only gets a seed where a path-free, port-free allowlist entry covers all of it.
    - A `*.example.com` site location leaves the apex `example.com` unseeded unless another pattern covers it, and where two site locations' hosts overlap, the broader one doesn't seed the narrower one's host.
    - With no main location, only site-location pages are seeded.
    - Before a settings change is stored, the early scripts built from the previous settings are removed, and the new ones are registered once it's stored, so a page that loads in between gets no early value rather than one from the old settings. If storing fails, the scripts for the settings still stored are registered again. If building fails, no early scripts remain until the next settings change or browser restart. GeoSpoof waits at most a second for Firefox to remove the old scripts; if `userScripts` doesn't answer by then, the change is stored anyway and the old scripts can stay until Firefox's call returns.

    Chromium and Safari have no bootstrap.

11. **Per-site locations: the Accept-Language header (Chromium, Safari).** On Chromium, with Filters set to every site, the main location's header stays a global `declarativeNetRequest` rule, so new tabs and sites without a site location are covered from their first request. Tabs on a site location whose language differs get a higher-priority per-tab session rule, refreshed when a tab starts navigating, so only a navigation into or out of such a site can send its first request with the previous site's value. In Allowlist or Denylist mode every tab's header comes from per-tab rules, as it did before site locations, so a new tab's first request can go out unmodified. On Safari, with Filters set to every site, the header stays the main location's on every site, including site-location sites, because MDN's compatibility data lists no per-tab rule condition for Safari and its handling of overlapping rule priorities isn't confirmed. So on a site-location site in Match mode, the header and `navigator.languages` can name different languages. Firefox sets the header per request and has no such race.

12. **Per-site locations: embedded content follows the page it's in.** Every frame and worker in a tab gets the top-level page's decision. A Twitch player embedded on another site gets that site's location, not Twitch's, and a page embedded inside `twitch.tv` gets Twitch's. A SharedWorker isn't tied to a tab, so on Firefox it resolves through the request's `frameAncestors` to the top-level page of the frame that started it. In a real-browser check, Firefox 159 reported neither a tab nor `frameAncestors` for a SharedWorker script, whether the page or an embedded frame started it. Then GeoSpoof can't see the worker's top-level page and judges the worker by the document that started it. Filters follow that document's URL, so a worker that an embedded frame starts can be spoofed on a page Filters exclude, or left unspoofed, with the real time zone, on a page they include. A site location applies only when Firefox marks the request as not third-party, the background has read the open tabs since it started, a tab on the same site is open, and every open tab on that site resolves to the same site location as that document. Otherwise the worker gets the main location, if you've set one, and never another page's site location. So a SharedWorker that a page with a site location starts keeps it, but one that a cross-site frame starts gets the main location while the frame reports the page's site location, and so do SharedWorkers on a site whose open tabs have different site locations. Since a SharedWorker can be shared across tabs, it keeps the values of the page that started it.

13. **Per-site locations: some open pages keep old values until reloaded.** A change is pushed to open tabs right away, as for any settings change. A page in the back/forward cache can't receive that push, so when it's restored it asks for current settings and picks up changes made while it was cached. A worker that's already running keeps the values it started with. A value changing under a live page is also a visible discontinuity, so the popup suggests reloading after each change.

14. **Per-site locations: prerendered pages (Chrome).** Chrome can prerender a page (speculation rules, the omnibox) inside the tab the user is still looking at, so `tab.url` is the page being left. The prerendered page itself is judged by its own URL, for Filters and per-site locations alike (see [GET_SETTINGS](#get_settings)). Its subframes can't be: a message sender names no parent document, and finding one needs the optional `webNavigation` permission. So until the page is shown, its subframes follow the page being left for Filters and get the main location, if you've set one, but never a per-site location: the page being left's per-site location may belong to a different site than the prerendered page. When it's shown, every frame asks for its settings again (`prerenderingchange`) and catches up. Engine-level Spoofing's debugger session is attached to the tab, not the prerendered page, so that page keeps the injected timezone until it's shown and the session takes over. From a tab that session already holds, Chrome 156 didn't prerender at all: the speculation rule's page loaded normally when the link was followed, as it does with DevTools attached. The `Accept-Language` header can't follow the prerendered page: header rules are per tab, so its requests carry the visible page's value until it's shown. Measured in Chrome 156 under Match mode, prerendering a Paris site from a Tokyo site sent `ja-JP` (with `Sec-Purpose: prefetch;prerender`) while the page reported `fr-FR`.

15. **Per-site locations: Engine-level Spoofing right after a cross-site navigation (Chrome).** The debugger override follows the tab's top-level page: it's switched when a navigation starts (`onBeforeNavigate`, or the `tabs.onUpdated` fallback) and applied again when it commits. In Chrome 156 an override sent while a cross-site navigation is under way doesn't reach the new document before that document's first scripts run, so they see the zone the tab had before: after moving from a site with a per-site location (Tokyo) to one without (Los Angeles) in the same tab, the second site's first `<head>` script read `Asia/Tokyo`. The page's own `Date`/`Intl` report its zone once its settings arrive (the injected fallback, see [Engine-level Spoofing (Chromium)](#engine-level-spoofing-chromium)), and its workers and later reads follow the override applied at commit. Measured against a local server on both attach paths: 40 of 40 same-tab cross-site navigations at 0 ms and at 50 ms server delay (median navigation 29 ms and 76 ms), and the same with a 1 s delay, after a cross-site redirect, and on a navigation a service worker answers. Holding each document response until the zone was set (CDP `Fetch` at the response stage) was tried and rejected: the override didn't land while the response was held, so every navigation waited out the 1 s safety timeout (median 1.1–1.2 s instead of 29 ms) and all 40 still leaked. Navigations that keep the zone, such as a reload or moving between two pages with the same location, aren't affected.

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
