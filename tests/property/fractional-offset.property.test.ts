/**
 * Property tests: `getTimezoneOffset` precision before standard time.
 * See docs/API.md "Sub-minute historical offsets".
 *
 * For any zone, any instant from 1800 to 2030 and either native behavior
 * (fractional: SpiderMonkey, V8 from Chrome 156; truncated: V8 before 156,
 * JavaScriptCore):
 *
 *   Property 1: the main realm's getTimezoneOffset is the engine's value, the
 *               getters keep the seconds, and toString's GMT±HHMM is the offset
 *               truncated toward zero.
 *   Property 2: the worker payload returns exactly what the main realm returns,
 *               so a page can't compare the two and find a difference.
 */
import { describe, test, expect, beforeAll } from "vitest";
import fc from "fast-check";
import vm from "node:vm";
import { buildStandaloneWorkerPayload } from "@/shared/worker-payload";
import {
  eastSecondsAt,
  expectedGto,
  gettersWestMinutes,
  gmtTokenEastMinutes,
} from "../helpers/lmt-offsets";
import {
  loadInjectedDateRealm,
  type BuildDateRealm,
  type InjectedState,
} from "../helpers/synthetic-date-realm";

const ZONES = [...new Set([...Intl.supportedValuesOf("timeZone"), "UTC"])];
const zoneArb = fc.constantFrom(...ZONES);
const instantArb = fc.integer({ min: Date.UTC(1800, 0, 1), max: Date.UTC(2030, 0, 1) });

let state: InjectedState;
let realm: BuildDateRealm;

beforeAll(async () => {
  ({ state, realm } = await loadInjectedDateRealm());
});

/** What a page reads: the offset three ways. */
interface OffsetReading {
  gto: number;
  gettersWest: number;
  gmtEast: number | null;
}

function read(d: Date): OffsetReading {
  return {
    gto: d.getTimezoneOffset(),
    gettersWest: gettersWestMinutes(d),
    gmtEast: gmtTokenEastMinutes(d.toString()),
  };
}

function mainRealmReading(zone: string, t: number, fractional: boolean): OffsetReading {
  state.setTimezoneData({ identifier: zone, offset: 0, dstOffset: 0 });
  return read(realm(fractional)(t));
}

const workerRealms = new Map<string, DateConstructor>();
function workerDate(zone: string, fractional: boolean): DateConstructor {
  const key = `${zone}|${fractional}`;
  let D = workerRealms.get(key);
  if (!D) {
    const sandbox: Record<string, unknown> = { self: {} };
    vm.createContext(sandbox);
    vm.runInContext(buildStandaloneWorkerPayload(zone, null, fractional, false), sandbox);
    D = (sandbox.self as { Date: DateConstructor }).Date;
    workerRealms.set(key, D);
  }
  return D;
}

describe("getTimezoneOffset precision before standard time", () => {
  test("Property 1: the main realm matches the engine and agrees with the getters and toString", () => {
    fc.assert(
      fc.property(zoneArb, instantArb, fc.boolean(), (zone, t, fractional) => {
        const eastSec = eastSecondsAt(zone, t);
        const r = mainRealmReading(zone, t, fractional);
        expect(r.gto).toBe(expectedGto(eastSec, fractional));
        expect(r.gettersWest).toBe(expectedGto(eastSec, true));
        // `+ 0` turns a -0 from truncating a small negative offset into +0.
        expect(r.gmtEast).toBe(Math.trunc(eastSec / 60) + 0);
      }),
      { numRuns: 300 }
    );
  });

  test("Property 2: the worker payload reads exactly what the main realm reads", () => {
    fc.assert(
      fc.property(zoneArb, instantArb, fc.boolean(), (zone, t, fractional) => {
        const main = mainRealmReading(zone, t, fractional);
        const worker = read(new (workerDate(zone, fractional))(t));
        expect(worker).toStrictEqual(main);
      }),
      { numRuns: 150 }
    );
  });
});
