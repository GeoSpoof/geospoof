import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { buildStandaloneWorkerPayload } from "@/shared/worker-payload";
import {
  LMT_CASES,
  TZP_INSTANTS,
  eastSecondsAt,
  expectedGto,
  gettersWestMinutes,
  gmtTokenEastMinutes,
} from "../../helpers/lmt-offsets";

/**
 * Executes the standalone worker payload (the string prepended to worker
 * scripts) inside an isolated `node:vm` realm and returns that realm's
 * (now spoofed) `Date` constructor.
 *
 * Isolation matters: the payload mutates `Function.prototype.toString`,
 * `Intl.DateTimeFormat`, `Date.prototype.*`, and the global `Date`. Running it
 * in a fresh vm context keeps those mutations out of the test process. The
 * realm inherits the standard intrinsics (Date, Intl, Object, …) but not
 * Node-specific globals, so we supply `self` for the payload's global install.
 *
 * The assertions are independent of the machine's timezone: the whole point of
 * the adjustment is to normalize an ambiguous local-time construction to the
 * spoofed zone regardless of what the host's real zone is.
 */
interface PayloadRealm {
  Date: DateConstructor;
  /** Evaluate an expression inside the worker realm (for realm-local checks). */
  evalInRealm: <T>(expr: string) => T;
}

function spoofedDateInRealm(timezone: string, fractionalOffset = false): PayloadRealm {
  const sandbox: Record<string, unknown> = { self: {} };
  vm.createContext(sandbox);
  vm.runInContext(buildStandaloneWorkerPayload(timezone, null, fractionalOffset), sandbox);
  const self = sandbox.self as { Date?: DateConstructor };
  if (typeof self.Date !== "function") {
    throw new Error("payload did not install a spoofed Date on self");
  }
  return {
    Date: self.Date,
    evalInRealm: <T>(expr: string): T => vm.runInContext(expr, sandbox) as T,
  };
}

describe("worker payload SPOOF_CORE — Date constructor / Date.parse spoofing", () => {
  // Asia/Kolkata is a stable UTC+5:30 zone with no DST — deterministic.
  it("parses an ambiguous local-time string in the spoofed zone", () => {
    const { Date: D } = spoofedDateInRealm("Asia/Kolkata");
    // 12:00 IST == 06:30 UTC
    expect(new D("2020-06-01T12:00:00").getTime()).toBe(Date.UTC(2020, 5, 1, 6, 30, 0));
  });

  it("applies the same adjustment via Date.parse", () => {
    const { Date: D } = spoofedDateInRealm("Asia/Kolkata");
    expect(D.parse("2020-06-01T12:00:00")).toBe(Date.UTC(2020, 5, 1, 6, 30, 0));
  });

  it("interprets multi-argument construction in the spoofed zone", () => {
    const { Date: D } = spoofedDateInRealm("Asia/Kolkata");
    // (2020, 5=Jun, 1, 12:00) local IST == 06:30 UTC
    const got = new (D as unknown as new (...a: number[]) => Date)(2020, 5, 1, 12, 0, 0).getTime();
    expect(got).toBe(Date.UTC(2020, 5, 1, 6, 30, 0));
  });

  it("leaves explicit-UTC (Z) strings unadjusted", () => {
    const { Date: D } = spoofedDateInRealm("Asia/Kolkata");
    expect(new D("2020-06-01T12:00:00Z").getTime()).toBe(Date.UTC(2020, 5, 1, 12, 0, 0));
  });

  it("leaves ISO date-only strings unadjusted (spec: UTC)", () => {
    const { Date: D } = spoofedDateInRealm("Asia/Kolkata");
    expect(new D("2020-06-01").getTime()).toBe(Date.UTC(2020, 5, 1, 0, 0, 0));
  });

  it("handles a DST-observing spoofed zone at both seasons", () => {
    const { Date: D } = spoofedDateInRealm("America/New_York");
    // Summer: EDT = UTC-4 → 12:00 local == 16:00 UTC
    expect(new D("2020-06-01T12:00:00").getTime()).toBe(Date.UTC(2020, 5, 1, 16, 0, 0));
    // Winter: EST = UTC-5 → 12:00 local == 17:00 UTC
    expect(new D("2020-01-01T12:00:00").getTime()).toBe(Date.UTC(2020, 0, 1, 17, 0, 0));
  });

  it("does not adjust the no-argument (current time) constructor", () => {
    const { Date: D } = spoofedDateInRealm("Asia/Kolkata");
    const before = Date.now();
    const got = new D().getTime();
    const after = Date.now();
    // "now" is an absolute instant, not an ambiguous local reading — no shift.
    expect(got).toBeGreaterThanOrEqual(before - 1000);
    expect(got).toBeLessThanOrEqual(after + 1000);
  });

  it("returns a string when called without new", () => {
    const { Date: D } = spoofedDateInRealm("Asia/Kolkata");
    expect(typeof (D as unknown as () => unknown)()).toBe("string");
  });
});

describe("worker payload SPOOF_CORE — Date getter spoofing", () => {
  it("reads every local getter in the spoofed zone", () => {
    const { Date: D } = spoofedDateInRealm("Asia/Kolkata"); // UTC+5:30, no DST
    // 2020-06-01T00:00:00Z == 2020-06-01T05:30:00 IST, a Monday.
    const d = new D(Date.UTC(2020, 5, 1, 0, 0, 0));
    expect(d.getFullYear()).toBe(2020);
    expect(d.getMonth()).toBe(5); // June (0-indexed)
    expect(d.getDate()).toBe(1);
    expect(d.getDay()).toBe(1); // Monday
    expect(d.getHours()).toBe(5);
    expect(d.getMinutes()).toBe(30);
    expect(d.getSeconds()).toBe(0);
    // getTimezoneOffset uses the positive-west convention: UTC+5:30 → -330.
    expect(d.getTimezoneOffset()).toBe(-330);
  });

  it("crosses a date boundary correctly in the spoofed zone", () => {
    const { Date: D } = spoofedDateInRealm("Asia/Kolkata");
    // 2020-06-01T20:00:00Z == 2020-06-02T01:30:00 IST → next day, hour 1.
    const d = new D(Date.UTC(2020, 5, 1, 20, 0, 0));
    expect(d.getDate()).toBe(2);
    expect(d.getHours()).toBe(1);
    expect(d.getMinutes()).toBe(30);
  });
});

describe("worker payload SPOOF_CORE — sub-minute historical offsets", () => {
  // Same cases and oracle as tests/unit/content/timezone-fractional-offset.test.ts,
  // so the worker and the main realm are checked against identical values.
  const realms = new Map<string, PayloadRealm>();
  function realmFor(zone: string, fractional: boolean): PayloadRealm {
    const key = `${zone}|${fractional}`;
    let realm = realms.get(key);
    if (!realm) {
      realm = spoofedDateInRealm(zone, fractional);
      realms.set(key, realm);
    }
    return realm;
  }

  for (const fractional of [true, false]) {
    describe(fractional ? "native keeps the fraction" : "native truncates", () => {
      for (const zone of LMT_CASES) {
        for (const t of TZP_INSTANTS) {
          it(`${zone.identifier} ${new Date(t).toISOString().slice(0, 10)}`, () => {
            const { Date: D } = realmFor(zone.identifier, fractional);
            const d = new D(t);
            const eastSec = eastSecondsAt(zone.identifier, t);
            const gto = d.getTimezoneOffset();

            expect(gto).toBe(expectedGto(eastSec, fractional));
            expect(gettersWestMinutes(d)).toBe(expectedGto(eastSec, true));

            // toString / toTimeString print whole minutes truncated toward zero,
            // like every engine; never "GMT+0918.98…".
            for (const str of [d.toString(), d.toTimeString()]) {
              expect(str).toMatch(/ GMT[+-]\d{4} \(/);
              expect(gmtTokenEastMinutes(str)).toBe(Math.trunc(eastSec / 60));
            }
          });
        }
      }
    });
  }

  it("prints 1879 Tokyo as GMT+0918 under both decisions", () => {
    for (const fractional of [true, false]) {
      const { Date: D } = realmFor("Asia/Tokyo", fractional);
      expect(new D(Date.UTC(1879, 0, 15, 13)).toString()).toContain(" GMT+0918 ");
    }
  });

  it("substitutes the decision as a literal and leaves no placeholder", () => {
    for (const fractional of [true, false]) {
      const payload = buildStandaloneWorkerPayload("Asia/Tokyo", null, fractional);
      expect(payload).toContain(`var __fractionalOffset = ${String(fractional)};`);
      expect(payload).not.toContain("__NATIVE_FRACTIONAL_OFFSET__");
      expect(payload).not.toContain("__SPOOF_TZ_ID__");
    }
  });
});

describe("worker payload SPOOF_CORE — Date setter spoofing", () => {
  it("round-trips setHours against the spoofed getters", () => {
    const { Date: D } = spoofedDateInRealm("Asia/Kolkata");
    const d = new D(Date.UTC(2020, 5, 1, 0, 0, 0));
    d.setHours(9, 30, 15, 0);
    // set in spoofed zone → read back in spoofed zone → must agree
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(30);
    expect(d.getSeconds()).toBe(15);
  });

  it("round-trips every local setter against its getter", () => {
    const { Date: D } = spoofedDateInRealm("Asia/Kolkata");
    const base = (): Date => new D(Date.UTC(2020, 5, 1, 0, 0, 0));
    let d: Date;
    d = base();
    d.setHours(9);
    expect(d.getHours()).toBe(9);
    d = base();
    d.setMinutes(45);
    expect(d.getMinutes()).toBe(45);
    d = base();
    d.setSeconds(20);
    expect(d.getSeconds()).toBe(20);
    d = base();
    d.setDate(15);
    expect(d.getDate()).toBe(15);
    d = base();
    d.setMonth(0);
    expect(d.getMonth()).toBe(0);
    d = base();
    d.setFullYear(1999);
    expect(d.getFullYear()).toBe(1999);
  });

  it("honors multi-argument setter forms (setHours h,m,s)", () => {
    const { Date: D } = spoofedDateInRealm("Asia/Kolkata");
    const d = new D(Date.UTC(2020, 5, 1, 0, 0, 0));
    d.setMinutes(12, 34);
    expect(d.getMinutes()).toBe(12);
    expect(d.getSeconds()).toBe(34);
  });

  it("produces a deterministic UTC epoch for setHours (spoofed zone)", () => {
    const { Date: D } = spoofedDateInRealm("Asia/Kolkata"); // UTC+5:30
    const d = new D(Date.UTC(2020, 5, 1, 0, 0, 0));
    d.setHours(9, 30, 15, 0);
    // 09:30:15 IST == 04:00:15 UTC, independent of the host's real zone
    expect(d.getTime()).toBe(Date.UTC(2020, 5, 1, 4, 0, 15, 0));
  });

  it("round-trips setFullYear / setDate", () => {
    const { Date: D } = spoofedDateInRealm("Asia/Kolkata");
    const d = new D(Date.UTC(2020, 5, 1, 6, 0, 0));
    d.setFullYear(1999);
    expect(d.getFullYear()).toBe(1999);
    d.setDate(15);
    expect(d.getDate()).toBe(15);
  });

  it("preserves native setter arity (.length)", () => {
    const { Date: D } = spoofedDateInRealm("Asia/Kolkata");
    const proto = D.prototype as unknown as Record<string, { length: number }>;
    expect(proto.setHours.length).toBe(4);
    expect(proto.setMinutes.length).toBe(3);
    expect(proto.setSeconds.length).toBe(2);
    expect(proto.setDate.length).toBe(1);
    expect(proto.setMonth.length).toBe(2);
    expect(proto.setFullYear.length).toBe(3);
  });

  it("masks the spoofed setters' toString as native (within the realm)", () => {
    const realm = spoofedDateInRealm("Asia/Kolkata");
    expect(
      realm.evalInRealm<string>("Function.prototype.toString.call(Date.prototype.setHours)")
    ).toContain("[native code]");
  });
});

describe("worker payload SPOOF_CORE — getMilliseconds", () => {
  it("passes through the millisecond component", () => {
    const { Date: D } = spoofedDateInRealm("Asia/Kolkata");
    expect(new D(Date.UTC(2020, 5, 1, 0, 0, 0, 123)).getMilliseconds()).toBe(123);
  });

  it("masks getMilliseconds toString as native (within the realm)", () => {
    const realm = spoofedDateInRealm("Asia/Kolkata");
    expect(
      realm.evalInRealm<string>("Function.prototype.toString.call(Date.prototype.getMilliseconds)")
    ).toContain("[native code]");
    expect(realm.evalInRealm<string>("Date.prototype.getMilliseconds.name")).toBe(
      "getMilliseconds"
    );
  });
});

describe("worker payload SPOOF_CORE — Date formatters", () => {
  // 2020-06-01T00:00:00Z == 2020-06-01T05:30:00 IST (Monday), UTC+5:30, no DST.
  const BASE = Date.UTC(2020, 5, 1, 0, 0, 0);

  it("toDateString / toTimeString / toString render in the spoofed zone", () => {
    const { Date: D } = spoofedDateInRealm("Asia/Kolkata");
    const d = new D(BASE);
    expect(d.toDateString()).toBe("Mon Jun 01 2020");
    expect(d.toTimeString()).toMatch(/^05:30:00 GMT\+0530 \(.+\)$/);
    expect(d.toString()).toMatch(/^Mon Jun 01 2020 05:30:00 GMT\+0530 \(.+\)$/);
  });

  it("toLocale* default to the spoofed zone", () => {
    const { Date: D } = spoofedDateInRealm("Asia/Kolkata");
    const d = new D(BASE);
    const ref = new Date(BASE);
    expect(d.toLocaleString("en-US")).toBe(
      ref.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
    );
    expect(d.toLocaleDateString("en-US")).toBe(
      ref.toLocaleDateString("en-US", { timeZone: "Asia/Kolkata" })
    );
    expect(d.toLocaleTimeString("en-US")).toBe(
      ref.toLocaleTimeString("en-US", { timeZone: "Asia/Kolkata" })
    );
  });

  it("toLocaleString honors an explicit timeZone (not overridden)", () => {
    const { Date: D } = spoofedDateInRealm("Asia/Kolkata");
    const d = new D(BASE);
    const ref = new Date(BASE);
    expect(d.toLocaleString("en-US", { timeZone: "UTC" })).toBe(
      ref.toLocaleString("en-US", { timeZone: "UTC" })
    );
  });

  it("masks formatter toString as native (within the realm)", () => {
    const realm = spoofedDateInRealm("Asia/Kolkata");
    for (const name of ["toString", "toDateString", "toTimeString", "toLocaleString"]) {
      expect(
        realm.evalInRealm<string>(`Function.prototype.toString.call(Date.prototype.${name})`)
      ).toContain("[native code]");
    }
  });
});

describe("worker payload SPOOF_CORE — Intl.DateTimeFormat", () => {
  it("resolvedOptions().timeZone reports the spoofed zone", () => {
    const realm = spoofedDateInRealm("Asia/Kolkata");
    expect(realm.evalInRealm<string>("new Intl.DateTimeFormat().resolvedOptions().timeZone")).toBe(
      "Asia/Kolkata"
    );
  });

  it("injects the spoofed zone into formatToParts when none is given", () => {
    const realm = spoofedDateInRealm("Asia/Kolkata");
    const hour = realm.evalInRealm<string>(
      `new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false })` +
        `.formatToParts(new Date(${Date.UTC(2020, 5, 1, 0, 0, 0)}))` +
        `.find(function (p) { return p.type === "hour"; }).value`
    );
    // 00:00 UTC == 05:30 IST → hour "5" (or "05")
    expect(parseInt(hour, 10)).toBe(5);
  });

  it("respects an explicit timeZone", () => {
    const realm = spoofedDateInRealm("Asia/Kolkata");
    expect(
      realm.evalInRealm<string>(
        'new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).resolvedOptions().timeZone'
      )
    ).toBe("UTC");
  });

  it("masks Intl.DateTimeFormat + resolvedOptions toString as native (within the realm)", () => {
    const realm = spoofedDateInRealm("Asia/Kolkata");
    expect(
      realm.evalInRealm<string>("Function.prototype.toString.call(Intl.DateTimeFormat)")
    ).toContain("[native code]");
    expect(
      realm.evalInRealm<string>(
        "Function.prototype.toString.call(Intl.DateTimeFormat.prototype.resolvedOptions)"
      )
    ).toContain("[native code]");
  });
});

describe("worker payload SPOOF_CORE — Temporal.Now", () => {
  it("spoofs Temporal.Now.timeZoneId + zonedDateTimeISO when Temporal is present", () => {
    const realm = spoofedDateInRealm("Asia/Kolkata");
    if (realm.evalInRealm<string>("typeof Temporal") === "undefined") {
      // The Node VM realm has no Temporal; this surface is covered by the
      // in-browser probe and the /test dashboard card on Temporal-capable engines.
      return;
    }
    expect(realm.evalInRealm<string>("Temporal.Now.timeZoneId()")).toBe("Asia/Kolkata");
    expect(realm.evalInRealm<string>("Temporal.Now.zonedDateTimeISO().timeZoneId")).toBe(
      "Asia/Kolkata"
    );
  });
});

describe("worker payload SPOOF_CORE — constructor toString masking", () => {
  it("masks the spoofed Date constructor's toString as native (within the realm)", () => {
    const realm = spoofedDateInRealm("Asia/Kolkata");
    // Masking is per-realm (each realm has its own Function.prototype), so the
    // check must run inside the worker realm — exactly where a page would see it.
    expect(realm.evalInRealm<string>("Function.prototype.toString.call(self.Date)")).toContain(
      "[native code]"
    );
    expect(realm.evalInRealm<string>("self.Date.name")).toBe("Date");
    expect(
      realm.evalInRealm<string>("Function.prototype.toString.call(self.Date.parse)")
    ).toContain("[native code]");
  });
});

describe("worker payload SPOOF_CORE — new.target / subclassing fidelity", () => {
  it("preserves the subclass prototype for Date (extends + Reflect.construct)", () => {
    const realm = spoofedDateInRealm("Asia/Kolkata");
    const r = realm.evalInRealm<{
      subInstance: boolean;
      subProto: boolean;
      reflectProto: boolean;
      noNewString: boolean;
    }>(`(function () {
      // Use self.Date — in this VM harness the spoofed constructor is installed
      // on self, whereas the VM's global Date stays native. In a real worker
      // self IS the global, so self.Date === Date.
      var SpoofedDate = self.Date;
      class MyDate extends SpoofedDate {}
      var d = new MyDate();
      function Fake() {}
      var x = Reflect.construct(SpoofedDate, [0], Fake);
      return {
        subInstance: d instanceof MyDate,
        subProto: Object.getPrototypeOf(d) === MyDate.prototype,
        reflectProto: Object.getPrototypeOf(x) === Fake.prototype,
        noNewString: typeof SpoofedDate() === "string",
      };
    })()`);
    expect(r.subInstance).toBe(true);
    expect(r.subProto).toBe(true);
    expect(r.reflectProto).toBe(true);
    expect(r.noNewString).toBe(true);
  });

  it("still spoofs the zone on a Date subclass instance", () => {
    const realm = spoofedDateInRealm("Asia/Kolkata");
    // 12:00 IST == 06:30 UTC — the epoch adjustment must still apply through
    // the subclass path.
    const epoch = realm.evalInRealm<number>(`(function () {
      class MyDate extends self.Date {}
      return new MyDate("2020-06-01T12:00:00").getTime();
    })()`);
    expect(epoch).toBe(Date.UTC(2020, 5, 1, 6, 30, 0));
  });

  it("preserves the subclass prototype for Intl.DateTimeFormat and still spoofs", () => {
    const realm = spoofedDateInRealm("Asia/Kolkata");
    const r = realm.evalInRealm<{
      subInstance: boolean;
      subProto: boolean;
      tz: string;
    }>(`(function () {
      class MyDTF extends Intl.DateTimeFormat {}
      var f = new MyDTF();
      return {
        subInstance: f instanceof MyDTF,
        subProto: Object.getPrototypeOf(f) === MyDTF.prototype,
        tz: f.resolvedOptions().timeZone,
      };
    })()`);
    expect(r.subInstance).toBe(true);
    expect(r.subProto).toBe(true);
    expect(r.tz).toBe("Asia/Kolkata");
  });
});

describe("worker payload SPOOF_CORE — native-method fidelity ([[Construct]] / prototype / arity)", () => {
  // A native prototype method / static is not a constructor: no own "prototype"
  // property, no [[Construct]] slot, and a spec-defined arity. Each spoofed
  // override must match, or a worker-side fingerprinter can distinguish it.
  const METHOD_CASES: ReadonlyArray<{ expr: string; name: string; length: number }> = [
    { expr: "Date.prototype.getHours", name: "getHours", length: 0 },
    { expr: "Date.prototype.getMinutes", name: "getMinutes", length: 0 },
    { expr: "Date.prototype.getSeconds", name: "getSeconds", length: 0 },
    { expr: "Date.prototype.getMilliseconds", name: "getMilliseconds", length: 0 },
    { expr: "Date.prototype.getDate", name: "getDate", length: 0 },
    { expr: "Date.prototype.getDay", name: "getDay", length: 0 },
    { expr: "Date.prototype.getMonth", name: "getMonth", length: 0 },
    { expr: "Date.prototype.getFullYear", name: "getFullYear", length: 0 },
    { expr: "Date.prototype.getTimezoneOffset", name: "getTimezoneOffset", length: 0 },
    { expr: "Date.prototype.toString", name: "toString", length: 0 },
    { expr: "Date.prototype.toTimeString", name: "toTimeString", length: 0 },
    { expr: "Date.prototype.toDateString", name: "toDateString", length: 0 },
    { expr: "Date.prototype.toLocaleString", name: "toLocaleString", length: 0 },
    { expr: "Date.prototype.toLocaleDateString", name: "toLocaleDateString", length: 0 },
    { expr: "Date.prototype.toLocaleTimeString", name: "toLocaleTimeString", length: 0 },
    { expr: "Date.prototype.setHours", name: "setHours", length: 4 },
    { expr: "Date.prototype.setMinutes", name: "setMinutes", length: 3 },
    { expr: "Date.prototype.setSeconds", name: "setSeconds", length: 2 },
    { expr: "Date.prototype.setDate", name: "setDate", length: 1 },
    { expr: "Date.prototype.setMonth", name: "setMonth", length: 2 },
    { expr: "Date.prototype.setFullYear", name: "setFullYear", length: 3 },
    {
      expr: "Intl.DateTimeFormat.prototype.resolvedOptions",
      name: "resolvedOptions",
      length: 0,
    },
    { expr: "self.Date.parse", name: "parse", length: 1 },
    { expr: "Function.prototype.toString", name: "toString", length: 0 },
  ];

  it.each(METHOD_CASES)(
    "$expr is non-constructable, prototype-less, native-looking (name/length)",
    ({ expr, name, length }) => {
      const realm = spoofedDateInRealm("Asia/Kolkata");
      const r = realm.evalInRealm<{
        hasProto: boolean;
        constructable: boolean;
        name: string;
        length: number;
        native: boolean;
      }>(`(function () {
        var fn = ${expr};
        // Isolate [[Construct]] from the body: fn as new.target against Array
        // throws ONLY if fn lacks [[Construct]] — fn's own body never runs.
        var constructable = false;
        try { Reflect.construct(Array, [], fn); constructable = true; } catch (e) {}
        return {
          hasProto: Object.prototype.hasOwnProperty.call(fn, "prototype"),
          constructable: constructable,
          name: fn.name,
          length: fn.length,
          native: Function.prototype.toString.call(fn).indexOf("[native code]") !== -1,
        };
      })()`);
      expect(r.hasProto).toBe(false);
      expect(r.constructable).toBe(false);
      expect(r.name).toBe(name);
      expect(r.length).toBe(length);
      expect(r.native).toBe(true);
    }
  );

  it("keeps the spoofed constructors (Date, Intl.DateTimeFormat) constructable with an own prototype", () => {
    const realm = spoofedDateInRealm("Asia/Kolkata");
    const r = realm.evalInRealm<{
      dateProto: boolean;
      dateConstructable: boolean;
      dtfProto: boolean;
      dtfConstructable: boolean;
    }>(`(function () {
      var okDate = false;
      try { Reflect.construct(Array, [], self.Date); okDate = true; } catch (e) {}
      var okDTF = false;
      try { Reflect.construct(Array, [], Intl.DateTimeFormat); okDTF = true; } catch (e) {}
      return {
        dateProto: Object.prototype.hasOwnProperty.call(self.Date, "prototype"),
        dateConstructable: okDate,
        dtfProto: Object.prototype.hasOwnProperty.call(Intl.DateTimeFormat, "prototype"),
        dtfConstructable: okDTF,
      };
    })()`);
    expect(r.dateProto).toBe(true);
    expect(r.dateConstructable).toBe(true);
    expect(r.dtfProto).toBe(true);
    expect(r.dtfConstructable).toBe(true);
  });

  it("strips prototype + [[Construct]] from Temporal.Now.* when Temporal is present", () => {
    const realm = spoofedDateInRealm("Asia/Kolkata");
    if (realm.evalInRealm<string>("typeof Temporal") === "undefined") {
      // The Node VM realm has no Temporal; covered in-browser + on the /test
      // dashboard for Temporal-capable engines.
      return;
    }
    const r = realm.evalInRealm<Array<{ name: string; hasProto: boolean; constructable: boolean }>>(
      `["timeZoneId","plainDateTimeISO","plainDateISO","plainTimeISO","zonedDateTimeISO"].map(
        function (n) {
          var fn = Temporal.Now[n];
          var constructable = false;
          try { Reflect.construct(Array, [], fn); constructable = true; } catch (e) {}
          return {
            name: n,
            hasProto: Object.prototype.hasOwnProperty.call(fn, "prototype"),
            constructable: constructable,
          };
        }
      )`
    );
    for (const entry of r) {
      expect(entry.hasProto, entry.name).toBe(false);
      expect(entry.constructable, entry.name).toBe(false);
    }
  });
});
