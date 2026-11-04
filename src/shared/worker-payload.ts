/**
 * Shared Worker timezone- and locale-spoofing payload.
 *
 * This module is consumed by both:
 *
 *   1. `src/content/injected/worker-patching.ts` — the content-script
 *      Worker constructor wrapper that handles classic, blob-URL, and
 *      data-URL workers by prepending the payload at construction time.
 *   2. `src/background/worker-request-filter.ts` — the Firefox-only
 *      `webRequest.filterResponseData` listener that prepends the
 *      payload to module-worker and service-worker script responses
 *      at the network layer.
 *
 * By sharing the exact same spoofing core between the two paths we
 * guarantee that a worker caught by either path sees identical
 * override behaviour — no drift between the content-script and
 * background versions.
 *
 * The core uses `var` and ES5-compatible syntax throughout so it
 * works in both classic workers (non-strict-by-default) and module
 * workers (strict-by-default) without transformation. The surrounding
 * IIFE handles the "use strict" difference by not relying on any
 * non-strict-mode behaviours.
 */

import type { SpoofedLocalePayload } from "@/shared/locale/resolver";

/**
 * The core timezone spoofing payload. Overrides `Date`, `Intl.DateTimeFormat`,
 * and the Date prototype methods inside whatever scope it runs in. Does NOT
 * include Worker-constructor interception or importScripts wrapping — those
 * are layered on top by callers that need them.
 *
 * Uses a `__SPOOF_TZ_ID__` placeholder that must be replaced with a
 * JSON-stringified IANA identifier before the payload is handed to a Worker.
 */
/**
 * The anti-fingerprint masking helpers shared by every worker payload section.
 *
 * Split out of {@link SPOOF_CORE} so a payload can carry LOCALE spoofing without
 * timezone spoofing (and vice versa) while still defining `__register` /
 * `__nativeMethod` exactly once. `SPOOF_CORE` still concatenates these first, so
 * its behavior is unchanged for existing callers.
 *
 * Nothing in here depends on `__tz_id`, which is why hoisting it above the
 * timezone body is safe.
 */
export const SPOOF_MASK_HELPERS = `
// --- Function.prototype.toString masking ---
// Without this, fingerprinters (notably CreepJS) detect our overrides
// because SpoofedDTF.toString() returns the JS source instead of
// "function DateTimeFormat() { [native code] }". We maintain a
// registry of patched functions and make toString lie about them.
// The wrapper itself also lies about its own toString so it can't
// be detected by introspecting Function.prototype.toString.
//
// __register additionally sets fn.name to the native name so that
// detectors comparing Function.prototype.toString.call(fn) against
// "function " + fn.name + "() { [native code] }" (CreepJS's
// getClientCode pattern) see a consistent mask across both surfaces.
//
// Engine-specific native format: Chrome/V8 returns
//   "function X() { [native code] }"           (single line)
// while Firefox/SpiderMonkey returns
//   "function X() {\\n    [native code]\\n}"    (multi-line, 4-space indent)
// We derive __nativeP1 / __nativeP2 at runtime by splitting a
// known-native constructor's source around its name, so our mask
// matches whatever shape the host engine produces.
var __nativeToString = Function.prototype.toString;
var __overrideRegistry = new Map();
var __nativeSplit = __nativeToString.call(Number).split("Number");
var __nativeP1 = __nativeSplit[0]; // e.g. "function " or "function "
var __nativeP2 = __nativeSplit[1] || "() { [native code] }";
function __register(fn, nativeName) {
  __overrideRegistry.set(fn, nativeName);
  try {
    Object.defineProperty(fn, "name", {
      value: nativeName,
      configurable: true,
      enumerable: false,
      writable: false
    });
  } catch(e) {
    // Some engines have non-configurable name on function declarations;
    // in that case toString masking alone has to carry the stealth.
  }
}
// Concise-method form (the ES2015 { m(){} }.m syntax) so the installed
// toString has NO own "prototype" and NO [[Construct]] slot — exactly like a
// native method. A plain function expression would carry both and be a tell.
var __maskedToString = {
  toString() {
    var name = __overrideRegistry.get(this);
    if (name !== undefined) {
      return __nativeP1 + name + __nativeP2;
    }
    return __nativeToString.call(this);
  }
}.toString;
__register(__maskedToString, "toString");
Function.prototype.toString = __maskedToString;

// --- Native-method fidelity wrapper ---
// A native prototype method / static is NOT a constructor: it has no own
// "prototype" property and no [[Construct]] internal slot, so
// "new Date.prototype.getHours()" and "Reflect.construct(Array, [], getHours)"
// throw "not a constructor". A plain "function foo(){}" override carries both a
// prototype and [[Construct]], which a fingerprinter running inside a worker
// can detect (hasOwnProperty("prototype"), Reflect.construct-with-new.target).
//
// __nativeMethod wraps a spoofing implementation in a concise method — the only
// callable form that is simultaneously non-constructable, prototype-less, AND
// binds 'this' dynamically (an arrow can't carry 'this'; a function expression
// carries [[Construct]]). It also stamps the native name + arity and registers
// the wrapper for toString masking, so length/name/toString probes pass too.
// Mirrors the main realm's stripConstruct + disguiseAsNative. Constructors
// (SpoofedDate / SpoofedDTF) are intentionally NOT routed through this — they
// must keep their prototype and [[Construct]].
function __nativeMethod(fn, name, length) {
  var wrapped = {
    m() {
      return Reflect.apply(fn, this, Array.prototype.slice.call(arguments));
    }
  }.m;
  try {
    Object.defineProperty(wrapped, "name", {
      value: name,
      configurable: true,
      enumerable: false,
      writable: false
    });
  } catch (e) {
    // non-configurable name on some engines — toString masking still carries it.
  }
  try {
    Object.defineProperty(wrapped, "length", {
      value: length,
      configurable: true,
      enumerable: false,
      writable: false
    });
  } catch (e) {
    // best effort — length rarely non-configurable.
  }
  __register(wrapped, name);
  return wrapped;
}

// --- Cross-body locale hook ---
// The timezone body and the locale body are emitted independently (either can
// appear without the other), but Intl.DateTimeFormat needs BOTH axes injected
// from its single wrapper. Declaring the hook here — in the section that is
// always emitted first — means the timezone body can consult the spoofed tag
// without caring whether the locale body was included or in what order.
// Stays null unless the locale body sets it.
var __spoofLocaleTag = null;
// "Use the default locale" is NOT only \`undefined\`. ECMA-402
// CanonicalizeLocaleList builds a LIST, and an empty list is what selects the
// default — so \`[]\`, \`{length:0}\` and a Set (no \`length\`) all mean the same as
// \`undefined\`. Checking only \`undefined\` left those reporting the real locale.
// Strings are always one requested tag; Intl.Locale instances are one explicit tag
// despite having no \`length\`. Mirrors isDefaultLocaleRequest in
// content/injected/locale-overrides.ts.
function __isDefaultLocales(locales) {
  if (locales === undefined) return true;
  if (typeof locales === "string" || locales === null) return false;
  if (typeof locales !== "object") return false;
  try {
    if (Object.prototype.toString.call(locales) === "[object Intl.Locale]") return false;
    var len = Number(locales.length);
    return !(len > 0);
  } catch (e) {
    return false;
  }
}
function __localeOr(locales) {
  return __isDefaultLocales(locales) && __spoofLocaleTag ? __spoofLocaleTag : locales;
}
// --- Reported locale of default-constructed Intl instances ---
// Instances whose locale WE supplied, mapped to the tag supplied. Injecting a tag
// switches ECMA-402 ResolveLocale from "report DefaultLocale() verbatim" to
// "run BestAvailableLocale", and the latter truncates subtags per SERVICE:
// collation and plural-rules data are language-keyed, so ja-JP becomes ja for
// Collator/PluralRules while NumberFormat and DateTimeFormat keep ja-JP. No real
// browser produces that disagreement (arkenfox TZP dedupes the nine values and
// reports "locale: mixed"), so the tag is replayed from resolvedOptions().
// Mirrors injectedLocaleTags in content/injected/locale-overrides.ts, which
// carries the full rationale.
var __injectedLocaleTags = new WeakMap();
function __noteLocale(instance, callerLocales) {
  if (__isDefaultLocales(callerLocales) && __spoofLocaleTag) {
    try { __injectedLocaleTags.set(instance, __spoofLocaleTag) } catch (e) {}
  }
  return instance;
}
function __applyReportedLocale(instance, resolved) {
  try {
    var tag = __injectedLocaleTags.get(instance);
    if (tag !== undefined && resolved && typeof resolved.locale === "string") {
      resolved.locale = tag;
    }
  } catch (e) {}
  return resolved;
}

`;

/**
 * The timezone-spoofing body. Requires `__SPOOF_TZ_ID__` (JSON IANA id),
 * `__NATIVE_FRACTIONAL_OFFSET__` and `__ENGINE_ZONE_MAY_CHANGE__` (`true` /
 * `false`) to be substituted, and assumes the masking helpers are already in
 * scope.
 */
const SPOOF_TZ_BODY = `
var __tz_id = __SPOOF_TZ_ID__;
// Whether this engine's native getTimezoneOffset keeps the seconds of a
// pre-standard-time offset (SpiderMonkey, V8 from Chrome 156) or truncates them
// (V8 before 156, JavaScriptCore). Decided once by the page realm's probe (or
// the Firefox background's, for workers patched at the network layer) and baked
// in, so the worker can't disagree with the page. See native-offset-precision.ts.
var __fractionalOffset = __NATIVE_FRACTIONAL_OFFSET__;

// --- Intl.DateTimeFormat override ---
var OrigDTF = Intl.DateTimeFormat;
var origResolvedOptions = OrigDTF.prototype.resolvedOptions;
var explicitTzInstances = new WeakSet();

function SpoofedDTF() {
  var args = Array.prototype.slice.call(arguments);
  // Honor new.target so subclassing / Reflect.construct preserve the subclass
  // prototype; when called without new (DateTimeFormat() still returns an
  // instance) fall back to the native constructor as the target.
  var nt = new.target || OrigDTF;
  var opts = args[1];
  // Inject the spoofed locale in this same wrapper so resolvedOptions() reports
  // a coherent {locale, timeZone} pair and everything ICU derives from the
  // locale matches the tag we claim. No-op when locale spoofing is off, and an
  // explicit caller locale always wins.
  var loc = __localeOr(args[0]);
  if (opts && typeof opts === "object" && "timeZone" in opts) {
    var instance = Reflect.construct(OrigDTF, [loc, opts], nt);
    explicitTzInstances.add(instance);
    return __noteLocale(instance, args[0]);
  }
  var newOpts = Object.assign({}, opts || {}, { timeZone: __tz_id });
  return __noteLocale(Reflect.construct(OrigDTF, [loc, newOpts], nt), args[0]);
}
SpoofedDTF.prototype = OrigDTF.prototype;
SpoofedDTF.supportedLocalesOf = OrigDTF.supportedLocalesOf;
__register(SpoofedDTF, "DateTimeFormat");
Object.defineProperty(Intl, "DateTimeFormat", {
  value: SpoofedDTF,
  writable: true,
  configurable: true,
  enumerable: false
});

var origRO = origResolvedOptions;
var spoofedRO = __nativeMethod(function resolvedOptions() {
  var result = origRO.call(this);
  if (!explicitTzInstances.has(this)) {
    result.timeZone = __tz_id;
  }
  // The locale axis needs replaying even when the timezone axis doesn't — see
  // __injectedLocaleTags.
  return __applyReportedLocale(this, result);
}, "resolvedOptions", 0);
OrigDTF.prototype.resolvedOptions = spoofedRO;

// --- Date.prototype.getTimezoneOffset override ---
var origGTZO = Date.prototype.getTimezoneOffset;
var spoofedGTZO = __nativeMethod(function getTimezoneOffset() {
  try {
    var fmt = new OrigDTF("en-US", { timeZone: __tz_id, timeZoneName: "shortOffset" });
    var parts = fmt.formatToParts(this);
    var tzPart = "";
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type === "timeZoneName") { tzPart = parts[i].value; break; }
    }
    // Match the optional :SS group too. Modern V8 emits seconds for pre-1906
    // sub-minute LMT offsets (e.g. "GMT+9:18:59"); without this the regex fails
    // and we fall through to the native offset — leaking the REAL system zone.
    var m = /^GMT(?:([+-])(\\d{1,2})(?::?(\\d{2}))?(?::(\\d{2}))?)?$/.exec(tzPart);
    if (!m) return origGTZO.call(this);
    if (!m[1]) return 0;
    var h = parseInt(m[2], 10);
    var min = m[3] ? parseInt(m[3], 10) : 0;
    var sec = m[4] ? parseInt(m[4], 10) : 0;
    var east = (m[1] === "-" ? -1 : 1) * (h * 60 + min + sec / 60);
    var west = -east;
    // Keep or truncate the seconds of a pre-standard-time offset exactly as the
    // host engine's native method does (see __fractionalOffset above).
    var result = __fractionalOffset ? west : Math.trunc(west);
    // Native returns +0 for a zero offset. ICU 78 (Chrome 156, Firefox 159)
    // formats one as "GMT+0" rather than "GMT", which lands here, and negating
    // it gives -0, which Object.is tells apart from the page realm's +0.
    // Mirrors zeroAsPositive in content/injected/timezone-overrides.ts.
    return result === 0 ? 0 : result;
  } catch(e) {
    return origGTZO.call(this);
  }
}, "getTimezoneOffset", 0);
Date.prototype.getTimezoneOffset = spoofedGTZO;

// --- Date.prototype.toLocaleString family ---
var origTLS = Date.prototype.toLocaleString;
var origTLDS = Date.prototype.toLocaleDateString;
var origTLTS = Date.prototype.toLocaleTimeString;
var spoofedTLS = __nativeMethod(function toLocaleString() {
  var args = Array.prototype.slice.call(arguments);
  var opts = args[1] && typeof args[1] === "object" ? Object.assign({}, args[1]) : {};
  if (!("timeZone" in opts)) opts.timeZone = __tz_id;
  return origTLS.call(this, args[0], opts);
}, "toLocaleString", 0);
var spoofedTLDS = __nativeMethod(function toLocaleDateString() {
  var args = Array.prototype.slice.call(arguments);
  var opts = args[1] && typeof args[1] === "object" ? Object.assign({}, args[1]) : {};
  if (!("timeZone" in opts)) opts.timeZone = __tz_id;
  return origTLDS.call(this, args[0], opts);
}, "toLocaleDateString", 0);
var spoofedTLTS = __nativeMethod(function toLocaleTimeString() {
  var args = Array.prototype.slice.call(arguments);
  var opts = args[1] && typeof args[1] === "object" ? Object.assign({}, args[1]) : {};
  if (!("timeZone" in opts)) opts.timeZone = __tz_id;
  return origTLTS.call(this, args[0], opts);
}, "toLocaleTimeString", 0);
Date.prototype.toLocaleString = spoofedTLS;
Date.prototype.toLocaleDateString = spoofedTLDS;
Date.prototype.toLocaleTimeString = spoofedTLTS;

// --- Date.prototype getter overrides (getHours, getMinutes, etc.) ---
var getterNames = ["getHours","getMinutes","getSeconds","getDate","getDay","getMonth","getFullYear"];
var origGetters = {};
for (var gi = 0; gi < getterNames.length; gi++) {
  origGetters[getterNames[gi]] = Date.prototype[getterNames[gi]];
}
function spoofedGetter(name) {
  return function() {
    try {
      var opts = { timeZone: __tz_id, hour12: false };
      switch(name) {
        case "getHours": opts.hour = "numeric"; break;
        case "getMinutes": opts.minute = "numeric"; break;
        case "getSeconds": opts.second = "numeric"; break;
        case "getDate": opts.day = "numeric"; break;
        case "getDay": opts.weekday = "short"; break;
        case "getMonth": opts.month = "numeric"; break;
        case "getFullYear": opts.year = "numeric"; break;
      }
      var fmt = new OrigDTF("en-US", opts);
      var parts = fmt.formatToParts(this);
      if (name === "getDay") {
        var dayMap = {Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};
        for (var di = 0; di < parts.length; di++) {
          if (parts[di].type === "weekday") return dayMap[parts[di].value] || 0;
        }
        return origGetters[name].call(this);
      }
      if (name === "getMonth") {
        for (var mi = 0; mi < parts.length; mi++) {
          if (parts[mi].type === "month") return parseInt(parts[mi].value, 10) - 1;
        }
        return origGetters[name].call(this);
      }
      var typeMap = {getHours:"hour",getMinutes:"minute",getSeconds:"second",getDate:"day",getFullYear:"year"};
      var partType = typeMap[name];
      for (var pi = 0; pi < parts.length; pi++) {
        if (parts[pi].type === partType) {
          var val = parseInt(parts[pi].value, 10);
          if (name === "getHours" && val === 24) return 0;
          return val;
        }
      }
      return origGetters[name].call(this);
    } catch(e) {
      return origGetters[name].call(this);
    }
  };
}
for (var si = 0; si < getterNames.length; si++) {
  var gName = getterNames[si];
  // All local Date getters have native arity 0.
  Date.prototype[gName] = __nativeMethod(spoofedGetter(gName), gName, 0);
}

// getMilliseconds is timezone-independent (whole-minute offsets don't affect
// the ms component), so this is a passthrough — installed only so its toString
// is masked consistently with the other getters, matching the main realm which
// also registers a passthrough here.
var __origGetMs = Date.prototype.getMilliseconds;
var __spoofedGetMs = __nativeMethod(function getMilliseconds() {
  return __origGetMs.call(this);
}, "getMilliseconds", 0);
Date.prototype.getMilliseconds = __spoofedGetMs;

// --- Date.prototype.toString / toTimeString / toDateString ---
function getLongTzName(d) {
  try {
    var f = new OrigDTF("en-US", { timeZone: __tz_id, timeZoneName: "long" });
    var p = f.formatToParts(d);
    for (var i = 0; i < p.length; i++) {
      if (p[i].type === "timeZoneName") return p[i].value;
    }
  } catch(e) {}
  return __tz_id;
}

// Every engine prints this offset as whole minutes truncated toward zero, even
// when getTimezoneOffset keeps the seconds (V8 date.cc, SpiderMonkey jsdate.cpp,
// JavaScriptCore DateConversion.cpp): 1879 Tokyo, +9:18:59, prints "GMT+0918".
function getGmtOffset(d) {
  var whole = Math.trunc(-d.getTimezoneOffset());
  var sign = whole < 0 ? "-" : "+";
  var abs = Math.abs(whole);
  var h = String(Math.floor(abs / 60)).padStart(2, "0");
  var m = String(abs % 60).padStart(2, "0");
  return "GMT" + sign + h + m;
}

Date.prototype.toString = __nativeMethod(function toString() {
  if (isNaN(this.getTime())) return "Invalid Date";
  var f = new OrigDTF("en-US", {
    timeZone: __tz_id, weekday: "short", month: "short",
    day: "2-digit", year: "numeric", hour: "2-digit",
    minute: "2-digit", second: "2-digit", hour12: false
  });
  var p = f.formatToParts(this);
  var get = function(t) { for (var i=0;i<p.length;i++) if(p[i].type===t) return p[i].value; return ""; };
  var hr = get("hour"); if (hr === "24") hr = "00";
  var offset = getGmtOffset(this);
  var tzName = getLongTzName(this);
  return get("weekday") + " " + get("month") + " " + get("day") + " " + get("year") + " " +
    hr + ":" + get("minute") + ":" + get("second") + " " + offset + " (" + tzName + ")";
}, "toString", 0);

Date.prototype.toTimeString = __nativeMethod(function toTimeString() {
  if (isNaN(this.getTime())) return "Invalid Date";
  var f = new OrigDTF("en-US", {
    timeZone: __tz_id, hour: "2-digit", minute: "2-digit",
    second: "2-digit", hour12: false
  });
  var p = f.formatToParts(this);
  var get = function(t) { for (var i=0;i<p.length;i++) if(p[i].type===t) return p[i].value; return ""; };
  var hr = get("hour"); if (hr === "24") hr = "00";
  var offset = getGmtOffset(this);
  var tzName = getLongTzName(this);
  return hr + ":" + get("minute") + ":" + get("second") + " " + offset + " (" + tzName + ")";
}, "toTimeString", 0);

Date.prototype.toDateString = __nativeMethod(function toDateString() {
  if (isNaN(this.getTime())) return "Invalid Date";
  var f = new OrigDTF("en-US", {
    timeZone: __tz_id, weekday: "short", month: "short",
    day: "2-digit", year: "numeric"
  });
  var p = f.formatToParts(this);
  var get = function(t) { for (var i=0;i<p.length;i++) if(p[i].type===t) return p[i].value; return ""; };
  return get("weekday") + " " + get("month") + " " + get("day") + " " + get("year");
}, "toDateString", 0);

// --- Date constructor + Date.parse override ---
// The prototype overrides above spoof how an existing Date is READ. But
// constructing a Date from an ambiguous local-time string ("2020-06-01T12:00:00")
// or from multi-argument components interprets those in the worker's REAL system
// zone, producing an epoch a page can diff against the main thread to recover the
// real offset. Mirror the main-realm date-constructor.ts: detect ambiguous inputs
// and shift the epoch by (realOffset - spoofedOffset) so construction behaves as
// if the worker were in the spoofed zone. origGTZO (captured above) is the native
// getTimezoneOffset — i.e. the REAL system offset — which is exactly what the
// adjustment needs.
var OrigDate = Date;
var OrigDateParse = Date.parse;

// Parse "GMT±HH:MM:SS" / "GMT±HH:MM" / "GMT±HHMM" / "GMT" into minutes east of
// UTC (fractional for sub-minute LMT offsets), or null. The :SS group keeps
// full precision so worker offsets match the main realm and native engine.
function __parseOffsetEast(tzPart) {
  var m = /^GMT(?:([+-])(\\d{1,2})(?::?(\\d{2}))?(?::(\\d{2}))?)?$/.exec(tzPart);
  if (!m) return null;
  if (!m[1]) return 0;
  var h = parseInt(m[2], 10);
  var mn = m[3] ? parseInt(m[3], 10) : 0;
  var sc = m[4] ? parseInt(m[4], 10) : 0;
  return (m[1] === "+" ? 1 : -1) * (h * 60 + mn + sc / 60);
}

// Spoofed-zone offset (minutes east of UTC) at a given instant.
function __spoofedOffsetEast(date, fallback) {
  try {
    var f = new OrigDTF("en-US", {
      timeZone: __tz_id,
      timeZoneName: "shortOffset",
    });
    var parts = f.formatToParts(date);
    var tzPart = "GMT";
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type === "timeZoneName") { tzPart = parts[i].value; break; }
    }
    var off = __parseOffsetEast(tzPart);
    return off === null ? fallback : off;
  } catch (e) {
    return fallback;
  }
}

// Ambiguous = no explicit tz designator (Z / UTC / GMT / ±HH[:MM]); an ISO
// date-only string (YYYY-MM-DD) is explicit UTC per spec, so not ambiguous.
function __isAmbiguousDateString(str) {
  var t = str.trim();
  if (/^\\d{4}-\\d{2}-\\d{2}$/.test(t)) return false;
  var explicit =
    /Z$/i.test(t) ||
    /\\b(?:UTC|GMT)\\b/i.test(str) ||
    /[+-]\\d{2}(?::?\\d{2})?$/.test(t);
  return !explicit;
}

// Real system IANA zone id, resolved via the NATIVE (pre-spoof) resolvedOptions
// so it isn't masked by our own DateTimeFormat override. Cached for the realm.
var __realTzId;
function __getRealTzId() {
  if (__realTzId !== undefined) return __realTzId;
  try {
    __realTzId = origResolvedOptions.call(new OrigDTF()).timeZone;
  } catch (e) {
    __realTzId = "UTC";
  }
  return __realTzId;
}

// True in Chromium's Engine-level Spoofing, where the engine's zone can change
// under this worker after it cached it (an override that lands later). Baked in
// by the page realm; false on every other path.
var __engineZoneMayChange = __ENGINE_ZONE_MAY_CHANGE__;

function __realOffsetEastFor(date, id) {
  try {
    var f = new OrigDTF("en-US", { timeZone: id, timeZoneName: "shortOffset" });
    var parts = f.formatToParts(date);
    var tzPart = "GMT";
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type === "timeZoneName") { tzPart = parts[i].value; break; }
    }
    var off = __parseOffsetEast(tzPart);
    return off === null ? -origGTZO.call(date) : off;
  } catch (e) {
    return -origGTZO.call(date);
  }
}

// Real system offset (minutes east of UTC) at an instant, at FULL sub-minute
// precision. Must NOT use getTimezoneOffset(): V8 truncates it while the native
// Date constructor keeps the fraction, and mixing the two leaks the dropped
// seconds into the adjustment (the "186.9333 vs 186.4667" Sao_Paulo drift).
// Native getTimezoneOffset is still the check that the cached zone is current:
// it differs by under a minute only through truncation.
function __realOffsetEast(date) {
  var off = __realOffsetEastFor(date, __getRealTzId());
  if (__engineZoneMayChange && Math.abs(off + origGTZO.call(date)) >= 1) {
    __realTzId = undefined;
    off = __realOffsetEastFor(date, __getRealTzId());
  }
  return off;
}

// ms to add to an epoch so a real-zone interpretation becomes a spoofed-zone
// one. Mirrors computeEpochAdjustment: resolve real + spoofed offsets at the
// same (full) precision, refine once for DST boundaries. No truncation here —
// both engines' constructors interpret local time at full precision; only
// getTimezoneOffset rounds, and it does so on its own path.
function __computeEpochAdjustment(parsedDate) {
  var realOffset = -__realOffsetEast(parsedDate); // minutes, positive = west, full precision
  var utcEpoch = parsedDate.getTime() + realOffset * 60000;
  try {
    var est = __spoofedOffsetEast(new OrigDate(utcEpoch), 0);
    var probe = new OrigDate(utcEpoch - est * 60000);
    var spoofedOffset = __spoofedOffsetEast(probe, est);
    if (spoofedOffset !== est) {
      var refined = new OrigDate(utcEpoch - spoofedOffset * 60000);
      spoofedOffset = __spoofedOffsetEast(refined, spoofedOffset);
    }
    return Math.round((-spoofedOffset - realOffset) * 60000);
  } catch (e) {
    return 0;
  }
}

function __spoofedDateParse(str) {
  if (typeof str !== "string") return OrigDateParse(str);
  var epoch = OrigDateParse(str);
  if (isNaN(epoch)) return NaN;
  if (__isAmbiguousDateString(str)) {
    return epoch + __computeEpochAdjustment(new OrigDate(epoch));
  }
  return epoch;
}

function __multiArgList(args) {
  return [
    args[0],
    args[1],
    args[2] != null ? args[2] : 1,
    args[3] != null ? args[3] : 0,
    args[4] != null ? args[4] : 0,
    args[5] != null ? args[5] : 0,
    args[6] != null ? args[6] : 0
  ];
}

function __multiArgDate(args) {
  return Reflect.construct(OrigDate, __multiArgList(args));
}

function SpoofedDate() {
  var args = Array.prototype.slice.call(arguments);
  var nt = new.target;
  // Called without new → current time as a string. Native returns a
  // system-zone string; route through the spoofed toString so it matches
  // "new Date().toString()" (CreepJS valid.date consistency).
  if (nt === undefined) {
    return new OrigDate().toString();
  }
  // Construct through new.target so subclassing / Reflect.construct preserve
  // the caller's prototype (native fidelity). For the ordinary new Date() case
  // nt is SpoofedDate, whose prototype IS OrigDate.prototype.
  var construct = function (ctorArgs) {
    return Reflect.construct(OrigDate, ctorArgs, nt);
  };
  if (args.length === 0) return construct([]);
  if (args.length === 1) {
    var a = args[0];
    if (typeof a === "number") return construct([a]);
    if (typeof a === "string") {
      try {
        var parsed = new OrigDate(a);
        if (isNaN(parsed.getTime())) return construct([a]);
        if (__isAmbiguousDateString(a)) {
          return construct([parsed.getTime() + __computeEpochAdjustment(parsed)]);
        }
        return construct([a]);
      } catch (e) {
        return construct([a]);
      }
    }
    return construct([a]);
  }
  try {
    var p = __multiArgDate(args);
    return construct([p.getTime() + __computeEpochAdjustment(p)]);
  } catch (e) {
    return construct(__multiArgList(args));
  }
}

SpoofedDate.prototype = OrigDate.prototype;
Object.defineProperty(SpoofedDate, "name", {
  value: "Date",
  configurable: true,
  enumerable: false,
  writable: false,
});
Object.defineProperty(SpoofedDate, "length", {
  value: 7,
  configurable: true,
  enumerable: false,
  writable: false,
});
var __dateSkip = { prototype: 1, name: 1, length: 1, parse: 1 };
var __dateStatics = Object.getOwnPropertyNames(OrigDate);
for (var __dsi = 0; __dsi < __dateStatics.length; __dsi++) {
  var __sp = __dateStatics[__dsi];
  if (__dateSkip[__sp]) continue;
  var __spd = Object.getOwnPropertyDescriptor(OrigDate, __sp);
  if (__spd) Object.defineProperty(SpoofedDate, __sp, __spd);
}
Object.defineProperty(SpoofedDate, "parse", {
  value: __nativeMethod(__spoofedDateParse, "parse", 1),
  configurable: true,
  enumerable: false,
  writable: true,
});
try {
  Object.setPrototypeOf(SpoofedDate, Function.prototype);
} catch (e) {
  /* best effort */
}
__register(SpoofedDate, "Date");
Object.defineProperty(OrigDate.prototype, "constructor", {
  value: SpoofedDate,
  configurable: true,
  enumerable: false,
  writable: true,
});
try {
  Object.defineProperty(self, "Date", {
    value: SpoofedDate,
    writable: true,
    configurable: true,
    enumerable: false,
  });
} catch (e) {
  self.Date = SpoofedDate;
}

// --- Date setter overrides (local wall-clock setters) ---
// The getters above read in the spoofed zone; without matching setters,
// "d.setHours(9); d.getHours()" doesn't round-trip (set writes in the real
// zone, get reads in the spoofed zone) — a self-inconsistency detectable
// inside the worker alone, and the resulting epoch differs from the main
// thread. Mirror date-setters.ts: read the current spoofed wall-clock parts,
// substitute the changed components, recompose the UTC epoch through the
// spoofed offset (with one DST refinement), and commit via native setTime.
// setMilliseconds / setTime / setUTC* are timezone-independent and left native.
var __origSetHours = OrigDate.prototype.setHours;
var __origSetMinutes = OrigDate.prototype.setMinutes;
var __origSetSeconds = OrigDate.prototype.setSeconds;
var __origSetDate = OrigDate.prototype.setDate;
var __origSetMonth = OrigDate.prototype.setMonth;
var __origSetFullYear = OrigDate.prototype.setFullYear;
var __origSetTime = OrigDate.prototype.setTime;

// Resolve a date's wall-clock components in the spoofed zone. month0 is
// 0-indexed to match Date.UTC / the constructor. Milliseconds are read from
// the native getter (timezone-independent for whole-minute offsets).
function __spoofedParts(date) {
  var f = new OrigDTF("en-US", {
    timeZone: __tz_id,
    hour12: false,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  var parts = f.formatToParts(date);
  var o = {};
  for (var i = 0; i < parts.length; i++) {
    o[parts[i].type] = parts[i].value;
  }
  var hour = parseInt(o.hour, 10);
  if (hour === 24) hour = 0;
  return {
    year: parseInt(o.year, 10),
    month0: parseInt(o.month, 10) - 1,
    day: parseInt(o.day, 10),
    hour: hour,
    minute: parseInt(o.minute, 10),
    second: parseInt(o.second, 10),
  };
}

// UTC epoch that, read back in the spoofed zone, yields the given wall-clock
// components. Refines the offset once against the final instant for DST.
function __composeUtcFromSpoofedLocal(year, month0, day, hour, minute, second, ms) {
  if (
    !isFinite(year) || !isFinite(month0) || !isFinite(day) || !isFinite(hour) ||
    !isFinite(minute) || !isFinite(second) || !isFinite(ms)
  ) {
    return NaN;
  }
  var rawUtc;
  if (year >= 0 && year <= 99) {
    // setFullYear-style small years are literal, not 1900+year like Date.UTC.
    var tmp = new OrigDate(OrigDate.UTC(2000, month0, day, hour, minute, second, ms));
    tmp.setUTCFullYear(Math.trunc(year));
    rawUtc = tmp.getTime();
  } else {
    rawUtc = OrigDate.UTC(year, month0, day, hour, minute, second, ms);
  }
  if (!isFinite(rawUtc)) return NaN;
  var est = __spoofedOffsetEast(new OrigDate(rawUtc), 0);
  var probe1 = new OrigDate(rawUtc - est * 60000);
  var offset = __spoofedOffsetEast(probe1, est);
  var utcEpoch = rawUtc - offset * 60000;
  var refined = __spoofedOffsetEast(new OrigDate(utcEpoch), offset);
  if (refined !== offset) {
    offset = refined;
    utcEpoch = rawUtc - offset * 60000;
  }
  return utcEpoch;
}

function __spoofedSetHours(h, m, s, ms) {
  var a = arguments;
  try {
    if (isNaN(this.getTime())) return NaN;
    var p = __spoofedParts(this);
    var nh = Number(h);
    var nm = a.length >= 2 ? Number(m) : p.minute;
    var ns = a.length >= 3 ? Number(s) : p.second;
    var nms = a.length >= 4 ? Number(ms) : this.getMilliseconds();
    var e = __composeUtcFromSpoofedLocal(p.year, p.month0, p.day, nh, nm, ns, nms);
    __origSetTime.call(this, e);
    return e;
  } catch (err) {
    return __origSetHours.apply(this, a);
  }
}

function __spoofedSetMinutes(m, s, ms) {
  var a = arguments;
  try {
    if (isNaN(this.getTime())) return NaN;
    var p = __spoofedParts(this);
    var nm = Number(m);
    var ns = a.length >= 2 ? Number(s) : p.second;
    var nms = a.length >= 3 ? Number(ms) : this.getMilliseconds();
    var e = __composeUtcFromSpoofedLocal(p.year, p.month0, p.day, p.hour, nm, ns, nms);
    __origSetTime.call(this, e);
    return e;
  } catch (err) {
    return __origSetMinutes.apply(this, a);
  }
}

function __spoofedSetSeconds(s, ms) {
  var a = arguments;
  try {
    if (isNaN(this.getTime())) return NaN;
    var p = __spoofedParts(this);
    var ns = Number(s);
    var nms = a.length >= 2 ? Number(ms) : this.getMilliseconds();
    var e = __composeUtcFromSpoofedLocal(p.year, p.month0, p.day, p.hour, p.minute, ns, nms);
    __origSetTime.call(this, e);
    return e;
  } catch (err) {
    return __origSetSeconds.apply(this, a);
  }
}

function __spoofedSetDate(d) {
  var a = arguments;
  try {
    if (isNaN(this.getTime())) return NaN;
    var p = __spoofedParts(this);
    var e = __composeUtcFromSpoofedLocal(
      p.year, p.month0, Number(d), p.hour, p.minute, p.second, this.getMilliseconds()
    );
    __origSetTime.call(this, e);
    return e;
  } catch (err) {
    return __origSetDate.apply(this, a);
  }
}

function __spoofedSetMonth(m, d) {
  var a = arguments;
  try {
    if (isNaN(this.getTime())) return NaN;
    var p = __spoofedParts(this);
    var nMonth = Number(m);
    var nDay = a.length >= 2 ? Number(d) : p.day;
    var e = __composeUtcFromSpoofedLocal(
      p.year, nMonth, nDay, p.hour, p.minute, p.second, this.getMilliseconds()
    );
    __origSetTime.call(this, e);
    return e;
  } catch (err) {
    return __origSetMonth.apply(this, a);
  }
}

function __spoofedSetFullYear(y, m, d) {
  var a = arguments;
  try {
    var epoch = this.getTime();
    // Spec: setFullYear on a NaN date starts from epoch 0.
    var p = isNaN(epoch) ? __spoofedParts(new OrigDate(0)) : __spoofedParts(this);
    var ms = isNaN(epoch) ? 0 : this.getMilliseconds();
    var nYear = Number(y);
    var nMonth = a.length >= 2 ? Number(m) : p.month0;
    var nDay = a.length >= 3 ? Number(d) : p.day;
    var e = __composeUtcFromSpoofedLocal(nYear, nMonth, nDay, p.hour, p.minute, p.second, ms);
    __origSetTime.call(this, e);
    return e;
  } catch (err) {
    return __origSetFullYear.apply(this, a);
  }
}

function __installSetter(name, fn, length) {
  OrigDate.prototype[name] = __nativeMethod(fn, name, length);
}
// Native arities: setHours(4) setMinutes(3) setSeconds(2) setDate(1)
// setMonth(2) setFullYear(3).
__installSetter("setHours", __spoofedSetHours, 4);
__installSetter("setMinutes", __spoofedSetMinutes, 3);
__installSetter("setSeconds", __spoofedSetSeconds, 2);
__installSetter("setDate", __spoofedSetDate, 1);
__installSetter("setMonth", __spoofedSetMonth, 2);
__installSetter("setFullYear", __spoofedSetFullYear, 3);

// --- Temporal.Now override ---
// Temporal.Now.timeZoneId() returns the system zone, and the plain*ISO /
// zonedDateTimeISO methods read the system zone when called with no explicit
// timezone argument — both leak the real timezone inside a worker even when
// Date/Intl are spoofed. Mirror the main-realm temporal.ts overrides: return
// the spoofed identifier for timeZoneId, and substitute it whenever the caller
// passed no explicit zone. The ZonedDateTime offset getters are intentionally
// left untouched — once the zone is spoofed they already derive the correct
// (spoofed) offset. Feature-detected: a no-op on engines without Temporal.
if (typeof Temporal !== "undefined" && Temporal && Temporal.Now) {
  try {
    var __TNow = Temporal.Now;
    var __origTZId = __TNow.timeZoneId.bind(__TNow);
    var __origPDTISO = __TNow.plainDateTimeISO.bind(__TNow);
    var __origPDISO = __TNow.plainDateISO.bind(__TNow);
    var __origPTISO = __TNow.plainTimeISO.bind(__TNow);
    var __origZDTISO = __TNow.zonedDateTimeISO.bind(__TNow);

    var __installNow = function(name, fn) {
      // All Temporal.Now.* methods have native arity 0.
      var wrapped = __nativeMethod(fn, name, 0);
      var d = Object.getOwnPropertyDescriptor(__TNow, name);
      Object.defineProperty(__TNow, name, {
        value: wrapped,
        writable: d ? d.writable : true,
        configurable: d ? d.configurable : true,
        enumerable: d ? d.enumerable : false
      });
    };

    // Keep __origTZId referenced so a future change can delegate to it; the
    // spoofed timeZoneId returns the baked identifier directly.
    void __origTZId;

    __installNow("timeZoneId", function timeZoneId() { return __tz_id; });
    __installNow("plainDateTimeISO", function plainDateTimeISO(tz) {
      return __origPDTISO(tz === undefined ? __tz_id : tz);
    });
    __installNow("plainDateISO", function plainDateISO(tz) {
      return __origPDISO(tz === undefined ? __tz_id : tz);
    });
    __installNow("plainTimeISO", function plainTimeISO(tz) {
      return __origPTISO(tz === undefined ? __tz_id : tz);
    });
    __installNow("zonedDateTimeISO", function zonedDateTimeISO(tz) {
      return __origZDTISO(tz === undefined ? __tz_id : tz);
    });
  } catch(e) {
    // Temporal override failed — leave originals in place.
  }
}
`;

/**
 * The locale ("Reported Language") spoofing body for worker scopes.
 *
 * Workers get their own `WorkerNavigator`, their own `Intl` constructors, and
 * their own primitive prototypes, so without this a page can read its real
 * language from inside a Worker even though the main realm reports the spoofed
 * one — and a main-realm/worker mismatch is precisely the kind of internal
 * inconsistency this feature exists to avoid.
 *
 * Independent of the timezone body: either can be emitted without the other.
 * Assumes the masking helpers are in scope and that `__SPOOF_LOCALE__` has been
 * substituted with a `{ tag, languages }` object.
 *
 * Mirrors `content/injected/locale-overrides.ts`: inject the tag into the
 * engine's native implementation and return the engine's own result, so every
 * value ICU derives from the locale stays consistent with the reported tag.
 * `Intl.DateTimeFormat` is handled by the timezone body, which injects the
 * locale alongside the zone in one wrapper.
 */
export const SPOOF_LOCALE_CORE = `
var __locale = __SPOOF_LOCALE__;

if (__locale && __locale.tag) {
  // Publish the tag on the shared hook declared in the masking helpers, so the
  // timezone body's Intl.DateTimeFormat wrapper injects the locale too —
  // regardless of which body was emitted first.
  __spoofLocaleTag = __locale.tag;

  // --- WorkerNavigator.language / .languages ---
  try {
    var __navProto = null;
    if (typeof WorkerNavigator !== "undefined" && WorkerNavigator.prototype) {
      __navProto = WorkerNavigator.prototype;
    } else if (typeof navigator !== "undefined" && navigator) {
      __navProto = Object.getPrototypeOf(navigator);
    }
    if (__navProto) {
      var __installLangGetter = function(name, produce) {
        var d = Object.getOwnPropertyDescriptor(__navProto, name);
        if (!d || typeof d.get !== "function") return;
        var nativeGet = d.get;
        // Concise-method form so the getter has no own "prototype" and no
        // [[Construct]] slot, matching a native accessor.
        var g = {
          get() {
            try {
              return produce();
            } catch (e) {
              return Reflect.apply(nativeGet, this, []);
            }
          }
        }.get;
        __register(g, "get " + name);
        Object.defineProperty(__navProto, name, {
          get: g,
          set: d.set,
          configurable: d.configurable,
          enumerable: d.enumerable
        });
      };
      __installLangGetter("language", function() { return __locale.tag; });
      __installLangGetter("languages", function() {
        // Fresh frozen copy per read so a page can't mutate our state or notice
        // the same array object being handed out twice.
        return Object.freeze(__locale.languages.slice());
      });
    }
  } catch (e) {
    // No WorkerNavigator prototype reachable — leave the natives in place.
  }

  // --- Default locale for the Intl constructors ---
  // DateTimeFormat is deliberately absent: the timezone body's SpoofedDTF
  // injects the locale together with the zone.
  try {
    var __intlLocaleCtors = [
      "NumberFormat",
      "Collator",
      "RelativeTimeFormat",
      "ListFormat",
      "PluralRules",
      "DisplayNames",
      "Segmenter",
      "DurationFormat"
    ];
    for (var __li = 0; __li < __intlLocaleCtors.length; __li++) {
      (function(name) {
        try {
          var Native = Intl[name];
          if (typeof Native !== "function") return; // not on this engine
          var nativeProto = Native.prototype;
          function SpoofedIntlCtor() {
            var args = Array.prototype.slice.call(arguments);
            var nt = new.target || Native;
            // Inject only when the caller requested no locale; an explicit
            // request must be honored verbatim. Note \`[]\` and other empty
            // array-likes count as "no request" — see __isDefaultLocales.
            var injected = args.slice();
            if (injected.length === 0) injected.push(undefined);
            if (__isDefaultLocales(injected[0])) injected[0] = __locale.tag;
            try {
              // Note the injected tag so resolvedOptions() reports it verbatim
              // instead of the engine's per-service truncation. Not done on the
              // fallback path, which uses the caller's own arguments.
              return __noteLocale(Reflect.construct(Native, injected, nt), args[0]);
            } catch (inner) {
              // Never let the injected tag break a construction the page would
              // otherwise have completed: retry with the caller's own arguments
              // so the native error (or success) is reproduced exactly.
              return Reflect.construct(Native, args, nt);
            }
          }
          __register(SpoofedIntlCtor, name);
          try {
            Object.defineProperty(SpoofedIntlCtor, "length", {
              value: Native.length,
              configurable: true,
              enumerable: false,
              writable: false
            });
          } catch (e) {
            // best effort
          }
          // Keep prototype identity so instanceof and brand checks still pass.
          SpoofedIntlCtor.prototype = nativeProto;
          if (typeof Native.supportedLocalesOf === "function") {
            SpoofedIntlCtor.supportedLocalesOf = Native.supportedLocalesOf;
          }
          Intl[name] = SpoofedIntlCtor;
          // Report the injected tag rather than the engine's per-service
          // truncation of it, so all the Intl constructors agree.
          try {
            var roDesc = Object.getOwnPropertyDescriptor(nativeProto, "resolvedOptions");
            if (roDesc && typeof roDesc.value === "function") {
              var nativeRO = roDesc.value;
              var wrappedRO = __nativeMethod(function resolvedOptions() {
                // Native first and unguarded: on a foreign \`this\` its brand
                // check must throw the genuine error.
                return __applyReportedLocale(this, nativeRO.call(this));
              }, "resolvedOptions", nativeRO.length);
              Object.defineProperty(nativeProto, "resolvedOptions", {
                value: wrappedRO,
                writable: roDesc.writable,
                configurable: roDesc.configurable,
                enumerable: roDesc.enumerable
              });
            }
          } catch (e) {
            // Leave resolvedOptions native for this constructor.
          }
        } catch (e) {
          // Leave this constructor native; the others still install.
        }
      })(__intlLocaleCtors[__li]);
    }
  } catch (e) {
    // Intl unavailable — nothing to do.
  }

  // --- toLocale* / localeCompare on the primitive prototypes ---
  try {
    var __patchWorkerLocaleMethod = function(ctor, name, localesIndex) {
      try {
        if (!ctor || !ctor.prototype) return;
        var d = Object.getOwnPropertyDescriptor(ctor.prototype, name);
        if (!d || typeof d.value !== "function") return;
        var native = d.value;
        var wrapped = __nativeMethod(function() {
          var args = Array.prototype.slice.call(arguments);
          while (args.length <= localesIndex) args.push(undefined);
          if (args[localesIndex] === undefined) args[localesIndex] = __locale.tag;
          try {
            return Reflect.apply(native, this, args);
          } catch (inner) {
            return Reflect.apply(native, this, Array.prototype.slice.call(arguments));
          }
        }, name, native.length);
        Object.defineProperty(ctor.prototype, name, {
          value: wrapped,
          writable: d.writable,
          configurable: d.configurable,
          enumerable: d.enumerable
        });
      } catch (e) {
        // Leave this method native.
      }
    };
    // \`locales\` is argument 0 everywhere except localeCompare, which takes the
    // string to compare against first.
    if (typeof Number !== "undefined") __patchWorkerLocaleMethod(Number, "toLocaleString", 0);
    if (typeof BigInt !== "undefined") __patchWorkerLocaleMethod(BigInt, "toLocaleString", 0);
    if (typeof Array !== "undefined") __patchWorkerLocaleMethod(Array, "toLocaleString", 0);
    if (typeof String !== "undefined") {
      __patchWorkerLocaleMethod(String, "localeCompare", 1);
      // Locale-sensitive case mapping genuinely differs by locale (Turkish
      // dotless i), so leaving these native would contradict the reported tag.
      __patchWorkerLocaleMethod(String, "toLocaleUpperCase", 0);
      __patchWorkerLocaleMethod(String, "toLocaleLowerCase", 0);
    }
  } catch (e) {
    // Leave the primitives native.
  }
}
`;

/**
 * The core timezone spoofing payload (masking helpers + timezone body), with
 * the `__SPOOF_TZ_ID__`, `__NATIVE_FRACTIONAL_OFFSET__` and
 * `__ENGINE_ZONE_MAY_CHANGE__` placeholders still in place. Callers build
 * through {@link buildWorkerSpoofCore}, which substitutes them.
 */
export const SPOOF_CORE = `${SPOOF_MASK_HELPERS}\n${SPOOF_TZ_BODY}`;

/**
 * Build a minimal standalone payload suitable for prepending to a worker
 * script response. Wraps the spoofing core in an IIFE so it doesn't leak
 * its `var` declarations into the worker's global scope.
 *
 * Returns an empty string when neither `identifier` nor `locale` is set —
 * callers should treat that as "don't modify the response."
 *
 * `fractionalOffset` is the page engine's `getTimezoneOffset` precision, and
 * `engineZoneMayChange` whether its zone can change under the worker (see
 * {@link buildWorkerSpoofCore}).
 */
export function buildStandaloneWorkerPayload(
  identifier: string | null | undefined,
  locale: SpoofedLocalePayload | null | undefined,
  fractionalOffset: boolean,
  engineZoneMayChange: boolean
): string {
  const core = buildWorkerSpoofCore(identifier, locale, fractionalOffset, engineZoneMayChange);
  if (!core) return "";
  return `(function(){\n"use strict";\n${core}\n})();\n`;
}

/**
 * Assemble the spoofing core for a worker scope: masking helpers, plus whichever
 * of the timezone and locale bodies apply, with their placeholders substituted.
 *
 * Returns an empty string when neither axis is active — callers treat that as
 * "don't modify the worker."
 *
 * Both worker paths (the injected constructor wrapper and the Firefox response
 * filter) go through here so a worker caught by either sees an identical core.
 * Either axis alone is sufficient: a user can spoof a locale with no location
 * (hence no timezone), or a timezone with no locale.
 *
 * `fractionalOffset` is baked into the timezone body as a literal: true when the
 * engine's native `getTimezoneOffset` keeps the seconds of a pre-standard-time
 * offset, false when it truncates them. It is required, not defaulted, so a
 * caller can't silently pick an answer that disagrees with the page realm.
 *
 * `engineZoneMayChange` is baked in the same way: true when the page realm is in
 * Chromium's Engine-level Spoofing, where the engine's own zone can change under
 * the worker after it cached it, so the worker re-checks its cached real zone.
 * Required for the same reason; false on the Firefox network path.
 */
export function buildWorkerSpoofCore(
  identifier: string | null | undefined,
  locale: SpoofedLocalePayload | null | undefined,
  fractionalOffset: boolean,
  engineZoneMayChange: boolean
): string {
  if (!identifier && !locale) return "";

  // Masking helpers first — both bodies depend on them, and the helpers declare
  // the `__localeOr` hook the timezone body's DateTimeFormat wrapper consults.
  const parts: string[] = [SPOOF_MASK_HELPERS];

  // Callback form throughout so any `$`-backreference patterns in the
  // substituted JSON (unlikely for real IANA IDs / BCP47 tags but possible for
  // user input) are passed through literally.
  if (identifier) {
    const idJson = JSON.stringify(identifier);
    // The fixed literal goes in first, so nothing inside the identifier can be
    // mistaken for its placeholder.
    const fractionalLiteral = fractionalOffset === true ? "true" : "false";
    const engineLiteral = engineZoneMayChange === true ? "true" : "false";
    parts.push(
      SPOOF_TZ_BODY.replace("__NATIVE_FRACTIONAL_OFFSET__", () => fractionalLiteral)
        .replace("__ENGINE_ZONE_MAY_CHANGE__", () => engineLiteral)
        .replace("__SPOOF_TZ_ID__", () => idJson)
    );
  }
  if (locale) {
    const localeJson = JSON.stringify(locale);
    parts.push(SPOOF_LOCALE_CORE.replace("__SPOOF_LOCALE__", () => localeJson));
  }

  return parts.join("\n");
}
