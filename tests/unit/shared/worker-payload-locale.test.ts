/**
 * Worker-scope locale ("Reported Language") spoofing.
 * Feature: locale-spoofing (Task 10.2) — Requirements 6.x, 7.x, 8.4, 9.x
 *
 * Workers have their own `WorkerNavigator`, their own `Intl` constructors, and
 * their own primitive prototypes. If the locale override didn't reach them, a
 * page could read its real language from inside a Worker while the main realm
 * reported the spoofed one — an internal mismatch that is directly observable
 * and worse than not spoofing at all. These tests run the real payload in an
 * isolated `node:vm` realm, the same harness `worker-payload.test.ts` uses.
 */

import vm from "node:vm";
import { buildStandaloneWorkerPayload, buildWorkerSpoofCore } from "@/shared/worker-payload";

const LOCALE = { tag: "fr-FR", languages: ["fr-FR", "fr"] };
const TZ = "Asia/Kolkata";

interface Realm {
  evalInRealm: <T>(expr: string) => T;
}

/**
 * Run a payload in a fresh realm.
 *
 * A minimal `WorkerNavigator` stand-in is installed with `language`/`languages`
 * as real accessors on a prototype, mirroring how the browser exposes them —
 * that accessor shape is exactly what the override has to replace.
 */
function realmWith(
  identifier: string | null,
  locale: { tag: string; languages: string[] } | null,
  realLanguage = "en-US",
  realLanguages: string[] = ["en-US", "en"]
): Realm {
  function WorkerNavigator(this: unknown): void {
    /* shape only */
  }
  Object.defineProperty(WorkerNavigator.prototype, "language", {
    get: () => realLanguage,
    configurable: true,
    enumerable: true,
  });
  Object.defineProperty(WorkerNavigator.prototype, "languages", {
    get: () => Object.freeze([...realLanguages]),
    configurable: true,
    enumerable: true,
  });
  const navigator = new (WorkerNavigator as unknown as new () => object)();

  const sandbox: Record<string, unknown> = { self: {}, WorkerNavigator, navigator };
  vm.createContext(sandbox);
  vm.runInContext(buildStandaloneWorkerPayload(identifier, locale, false, false), sandbox);
  return { evalInRealm: <T>(expr: string): T => vm.runInContext(expr, sandbox) as T };
}

describe("worker locale payload — navigator.language / languages", () => {
  it("reports the spoofed tag from navigator.language", () => {
    const r = realmWith(TZ, LOCALE);
    expect(r.evalInRealm<string>("navigator.language")).toBe("fr-FR");
  });

  it("reports the spoofed list from navigator.languages, with language first", () => {
    const r = realmWith(TZ, LOCALE);
    expect(r.evalInRealm<string[]>("Array.from(navigator.languages)")).toEqual(["fr-FR", "fr"]);
    expect(r.evalInRealm<boolean>("navigator.languages[0] === navigator.language")).toBe(true);
  });

  it("does not leak the real language anywhere in the advertised list", () => {
    const r = realmWith(TZ, LOCALE, "en-US", ["en-US", "en"]);
    const langs = r.evalInRealm<string[]>("Array.from(navigator.languages)");
    expect(langs.join(",")).not.toMatch(/en/i);
  });

  it("hands out a fresh frozen array each read so a page cannot corrupt state", () => {
    const r = realmWith(TZ, LOCALE);
    expect(r.evalInRealm<boolean>("navigator.languages !== navigator.languages")).toBe(true);
    expect(r.evalInRealm<boolean>("Object.isFrozen(navigator.languages)")).toBe(true);
    r.evalInRealm("try { navigator.languages.push('zz'); } catch (e) {}");
    expect(r.evalInRealm<string[]>("Array.from(navigator.languages)")).toEqual(["fr-FR", "fr"]);
  });

  it("leaves the real language alone when no locale is supplied", () => {
    const r = realmWith(TZ, null);
    expect(r.evalInRealm<string>("navigator.language")).toBe("en-US");
  });
});

describe("worker locale payload — Intl default locale", () => {
  it("NumberFormat defaults to the spoofed locale", () => {
    const r = realmWith(TZ, LOCALE);
    expect(r.evalInRealm<string>("new Intl.NumberFormat().resolvedOptions().locale")).toBe("fr-FR");
  });

  it("derived formatting genuinely matches the reported locale", () => {
    // The payoff of injecting the tag into ICU rather than faking output: the
    // separators are really French, so a site comparing the reported tag against
    // observed formatting sees no contradiction. fr-FR uses a comma decimal
    // separator and a non-ASCII group separator.
    const r = realmWith(TZ, LOCALE);
    const formatted = r.evalInRealm<string>("new Intl.NumberFormat().format(1234567.89)");
    expect(formatted).toContain(",89");
    expect(formatted).not.toBe("1,234,567.89");
  });

  // This assertion previously used `new Intl.Collator("fr-FR")` as the reference
  // for "what a genuine French browser reports", and required the spoofed default
  // to match its minimized "fr". That reference was wrong, and pinning it hid a
  // detectable tell for a release.
  //
  // ECMA-402 `ResolveLocale` has two branches, and they do not agree:
  //
  //   - EXPLICIT request → `BestAvailableLocale` strips trailing subtags until it
  //     finds a bundle in *that service's* available-locale set. Collation data is
  //     language-keyed, so a requested "fr-FR" minimizes to "fr" for `Collator`
  //     while `NumberFormat` keeps "fr-FR". Which services minimize is
  //     engine-specific: V8 also minimizes `PluralRules`, SpiderMonkey does not.
  //   - NO request (the branch a genuine French browser takes) → no candidate
  //     matches, so the spec falls back to `DefaultLocale()` and reports it
  //     VERBATIM. No availability lookup runs at all. `DefaultLocale()` is a
  //     single engine-wide string, so this branch CANNOT disagree across services.
  //
  // Verified empirically: with the host default locale forced to ja-JP, all nine
  // constructors report "ja-JP" — including the two that minimize an explicit
  // "ja-JP" to "ja".
  //
  // So a genuine French browser reports "fr-FR" from every constructor, and the
  // old expectation had us reporting "fr" from `Collator` and "fr-FR" from the
  // rest. arkenfox TZP collects `resolvedOptions().locale` from nine
  // constructors, dedupes, and reports `locale: mixed` as a detected lie — which
  // is exactly what shipped. The invariant is AGREEMENT on the tag.
  it("every Intl constructor reports the spoofed tag, so the nine agree", () => {
    const r = realmWith(TZ, LOCALE);
    const reported: Record<string, string> = {};
    for (const ctor of [
      "NumberFormat",
      "Collator",
      "PluralRules",
      "ListFormat",
      "RelativeTimeFormat",
      "Segmenter",
      "DurationFormat",
      "DateTimeFormat",
    ] as const) {
      const available = r.evalInRealm<boolean>(`typeof Intl.${ctor} === "function"`);
      if (!available) continue;
      reported[ctor] = r.evalInRealm<string>(`new Intl.${ctor}().resolvedOptions().locale`);
    }

    expect(Object.keys(reported).length).toBeGreaterThan(1);
    // TZP's own reduction: dedupe, and anything but a single value is "mixed".
    expect([...new Set(Object.values(reported))], JSON.stringify(reported)).toEqual(["fr-FR"]);
  });

  it("an explicit request still gets the engine's genuine minimization", () => {
    // Only the default is replayed. A page that explicitly asks for "fr-FR"
    // collation is entitled to see that it got "fr" data, exactly as it would
    // with no extension present.
    const r = realmWith(TZ, LOCALE);
    const spoofed = r.evalInRealm<string>('new Intl.Collator("fr-FR").resolvedOptions().locale');
    expect(spoofed).toBe(new Intl.Collator("fr-FR").resolvedOptions().locale);
  });

  it("honors an explicit locales argument instead of overriding it", () => {
    const r = realmWith(TZ, LOCALE);
    expect(r.evalInRealm<string>('new Intl.NumberFormat("de-DE").resolvedOptions().locale')).toBe(
      "de-DE"
    );
  });

  it("preserves instanceof and prototype identity", () => {
    const r = realmWith(TZ, LOCALE);
    expect(r.evalInRealm<boolean>("new Intl.NumberFormat() instanceof Intl.NumberFormat")).toBe(
      true
    );
  });

  it("keeps supportedLocalesOf working", () => {
    const r = realmWith(TZ, LOCALE);
    expect(r.evalInRealm<string[]>('Intl.NumberFormat.supportedLocalesOf(["fr-FR"])')).toContain(
      "fr-FR"
    );
  });

  it("honors new.target so subclassing keeps the subclass prototype", () => {
    const r = realmWith(TZ, LOCALE);
    expect(
      r.evalInRealm<boolean>(
        "(function(){ class X extends Intl.NumberFormat {}; return new X() instanceof X; })()"
      )
    ).toBe(true);
  });

  it("reproduces the native error for arguments the page got wrong", () => {
    // Intl.DisplayNames requires an options bag with `type`; injecting a locale
    // must not turn that native TypeError into a silent success.
    const r = realmWith(TZ, LOCALE);
    const threw = r.evalInRealm<boolean>(
      'typeof Intl.DisplayNames !== "function" ? true : (function(){ try { new Intl.DisplayNames(); return false; } catch (e) { return true; } })()'
    );
    expect(threw).toBe(true);
  });
});

describe("worker locale payload — Intl.DateTimeFormat carries BOTH axes", () => {
  it("reports the spoofed locale and the spoofed timezone together", () => {
    // DateTimeFormat is the one surface where both spoofed axes meet. It is
    // handled by the timezone body's single wrapper precisely so the two cannot
    // disagree; this is the regression guard for that.
    const r = realmWith(TZ, LOCALE);
    const opts = r.evalInRealm<{ locale: string; timeZone: string }>(
      "new Intl.DateTimeFormat().resolvedOptions()"
    );
    expect(opts.locale).toBe("fr-FR");
    expect(opts.timeZone).toBe(TZ);
  });

  it("still reports the spoofed timezone when no locale is active", () => {
    const r = realmWith(TZ, null);
    expect(
      r.evalInRealm<{ timeZone: string }>("new Intl.DateTimeFormat().resolvedOptions()").timeZone
    ).toBe(TZ);
  });

  it("hourCycle is whatever ICU derives for the spoofed locale", () => {
    // Not asserted as a fixed value — the point is that it comes from ICU for
    // fr-FR rather than being hand-set, so it cannot contradict the tag.
    const r = realmWith(TZ, LOCALE);
    const spoofed = r.evalInRealm<string>(
      "new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle"
    );
    const reference = new Intl.DateTimeFormat("fr-FR", { hour: "numeric" }).resolvedOptions()
      .hourCycle;
    expect(spoofed).toBe(reference);
  });
});

describe("worker locale payload — toLocale* / localeCompare", () => {
  it("Number.prototype.toLocaleString defaults to the spoofed locale", () => {
    const r = realmWith(TZ, LOCALE);
    expect(r.evalInRealm<string>("(1234.5).toLocaleString()")).toBe(
      (1234.5).toLocaleString("fr-FR")
    );
  });

  it("an explicit locale argument still wins", () => {
    const r = realmWith(TZ, LOCALE);
    expect(r.evalInRealm<string>('(1234.5).toLocaleString("de-DE")')).toBe(
      (1234.5).toLocaleString("de-DE")
    );
  });

  it("String.prototype.localeCompare uses the spoofed locale (arg index 1)", () => {
    const r = realmWith(TZ, LOCALE);
    // localeCompare takes the comparison string first, so the locales slot is
    // argument 1 — a wrong index here would silently pass the tag as `that`.
    expect(r.evalInRealm<number>('"a".localeCompare("b")')).toBe("a".localeCompare("b", "fr-FR"));
  });

  it("Array.prototype.toLocaleString defaults to the spoofed locale", () => {
    const r = realmWith(TZ, LOCALE);
    expect(r.evalInRealm<string>("[1234.5, 6789].toLocaleString()")).toBe(
      [1234.5, 6789].toLocaleString("fr-FR")
    );
  });

  it("locale-sensitive case mapping follows the spoofed locale", () => {
    // Turkish is the classic divergence: dotless i. Proves the case mappings
    // really consult the injected tag rather than the host locale.
    const r = realmWith(TZ, { tag: "tr-TR", languages: ["tr-TR", "tr"] });
    expect(r.evalInRealm<string>('"i".toLocaleUpperCase()')).toBe("i".toLocaleUpperCase("tr-TR"));
  });
});

describe("worker locale payload — anti-fingerprint parity", () => {
  it("overridden Intl constructors report [native code]", () => {
    const r = realmWith(TZ, LOCALE);
    expect(r.evalInRealm<string>("Intl.NumberFormat.toString()")).toContain("[native code]");
  });

  it("overridden toLocale* methods report [native code]", () => {
    const r = realmWith(TZ, LOCALE);
    expect(r.evalInRealm<string>("Number.prototype.toLocaleString.toString()")).toContain(
      "[native code]"
    );
    expect(r.evalInRealm<string>("String.prototype.localeCompare.toString()")).toContain(
      "[native code]"
    );
  });

  it("the navigator language getters report [native code]", () => {
    const r = realmWith(TZ, LOCALE);
    const src = r.evalInRealm<string>(
      'Object.getOwnPropertyDescriptor(WorkerNavigator.prototype, "language").get.toString()'
    );
    expect(src).toContain("[native code]");
  });

  it("overridden toLocale* methods keep native arity and are not constructable", () => {
    const r = realmWith(TZ, LOCALE);
    expect(
      r.evalInRealm<boolean>('Number.prototype.toLocaleString.hasOwnProperty("prototype")')
    ).toBe(false);
    expect(
      r.evalInRealm<boolean>(
        "(function(){ try { new Number.prototype.toLocaleString(); return false; } catch (e) { return true; } })()"
      )
    ).toBe(true);
  });
});

describe("worker payload assembly", () => {
  it("emits nothing when neither axis is active", () => {
    expect(buildStandaloneWorkerPayload(null, null, false, false)).toBe("");
    expect(buildStandaloneWorkerPayload(undefined, undefined, false, false)).toBe("");
    expect(buildWorkerSpoofCore(null, null, false, false)).toBe("");
  });

  it("emits a payload for locale alone, with no timezone", () => {
    // Reachable state: a custom locale with no location set. The worker must
    // still get the locale, or it would disagree with the page realm.
    const payload = buildStandaloneWorkerPayload(null, LOCALE, false, false);
    expect(payload).not.toBe("");
    const r = realmWith(null, LOCALE);
    expect(r.evalInRealm<string>("navigator.language")).toBe("fr-FR");
    expect(r.evalInRealm<string>("new Intl.NumberFormat().resolvedOptions().locale")).toBe("fr-FR");
  });

  it("emits a payload for timezone alone, with no locale", () => {
    expect(buildStandaloneWorkerPayload(TZ, null, false, false)).not.toBe("");
    expect(buildStandaloneWorkerPayload(TZ, undefined, false, false)).not.toBe("");
  });

  it("does not install a spoofed Date when only a locale is active", () => {
    // The timezone body must be genuinely absent, not merely inert — emitting it
    // without an identifier would bake in the string "__SPOOF_TZ_ID__".
    const payload = buildStandaloneWorkerPayload(null, LOCALE, false, false);
    expect(payload).not.toContain("__SPOOF_TZ_ID__");
    expect(payload).not.toContain("__SPOOF_LOCALE__");
  });

  it("substitutes both placeholders when both axes are active", () => {
    const payload = buildStandaloneWorkerPayload(TZ, LOCALE, false, false);
    expect(payload).not.toContain("__SPOOF_TZ_ID__");
    expect(payload).not.toContain("__SPOOF_LOCALE__");
    expect(payload).toContain(TZ);
    expect(payload).toContain("fr-FR");
  });
});
