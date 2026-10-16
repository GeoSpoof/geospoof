/**
 * Unit tests for session-cache edge cases
 * Feature: mv3-manifest-compat
 * Requirements: 3.7
 */

import { describe, test, expect, vi } from "vitest";
import {
  sessionGet,
  sessionRead,
  sessionSet,
  sessionDelete,
  sessionGetAll,
  sessionClearNamespace,
} from "@/background/session-cache";

/** Access session storage mock methods via index signature to avoid unbound-method lint. */
function sessionGetMock(): ReturnType<typeof vi.fn> {
  const session = browser.storage.session as unknown as Record<string, unknown>;
  return session["get"] as ReturnType<typeof vi.fn>;
}

function sessionSetMock(): ReturnType<typeof vi.fn> {
  const session = browser.storage.session as unknown as Record<string, unknown>;
  return session["set"] as ReturnType<typeof vi.fn>;
}

function sessionRemoveMock(): ReturnType<typeof vi.fn> {
  const session = browser.storage.session as unknown as Record<string, unknown>;
  return session["remove"] as ReturnType<typeof vi.fn>;
}

describe("session-cache edge cases", () => {
  describe("sessionGet", () => {
    test("returns undefined when key does not exist", async () => {
      const result = await sessionGet("nonexistent");
      expect(result).toBeUndefined();
    });

    test("returns undefined when storage.session.get throws", async () => {
      sessionGetMock().mockRejectedValueOnce(new Error("storage unavailable"));

      const result = await sessionGet("someKey");
      expect(result).toBeUndefined();
    });
  });

  describe("sessionRead", () => {
    test("a missing key is a successful read of undefined", async () => {
      await expect(sessionRead("nonexistent")).resolves.toEqual({ ok: true, value: undefined });
    });

    test("a stored value reads back", async () => {
      await sessionSet("readable", { n: 7 });
      await expect(sessionRead("readable")).resolves.toEqual({ ok: true, value: { n: 7 } });
    });

    test("a rejected read reports failure and does not log", async () => {
      sessionGetMock().mockRejectedValueOnce(new Error("storage unavailable"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await expect(sessionRead("someKey")).resolves.toEqual({ ok: false });
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });

  describe("sessionSet", () => {
    test("does not throw when storage.session.set fails", async () => {
      sessionSetMock().mockRejectedValueOnce(new Error("quota exceeded"));

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await expect(sessionSet("key", "value")).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("[WARN]"),
        "session-cache: write failed for key",
        "key",
        expect.any(Error)
      );

      warnSpy.mockRestore();
    });

    test("writes value that can be read back", async () => {
      await sessionSet("test", { foo: "bar" });
      const result = await sessionGet<{ foo: string }>("test");
      expect(result).toEqual({ foo: "bar" });
    });
  });

  describe("sessionDelete", () => {
    test("removes a previously stored key", async () => {
      await sessionSet("toDelete", 42);
      await sessionDelete("toDelete");
      const result = await sessionGet<number>("toDelete");
      expect(result).toBeUndefined();
    });

    test("does not throw when delete fails", async () => {
      sessionRemoveMock().mockRejectedValueOnce(new Error("remove failed"));

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await expect(sessionDelete("key")).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("sessionGetAll", () => {
    test("returns all entries under a namespace", async () => {
      await sessionSet("reverseGeo:37.7749,-122.4194", {
        city: "SF",
        country: "US",
        displayName: "San Francisco",
      });
      await sessionSet("reverseGeo:40.7128,-74.0060", {
        city: "NYC",
        country: "US",
        displayName: "New York",
      });
      await sessionSet("timezone:37.7749,-122.4194", {
        identifier: "America/Los_Angeles",
        offset: -480,
        dstOffset: 60,
      });

      const geoEntries = await sessionGetAll<{ city: string }>("reverseGeo");
      expect(Object.keys(geoEntries)).toHaveLength(2);
      expect(geoEntries["37.7749,-122.4194"]).toEqual({
        city: "SF",
        country: "US",
        displayName: "San Francisco",
      });
      expect(geoEntries["40.7128,-74.0060"]).toEqual({
        city: "NYC",
        country: "US",
        displayName: "New York",
      });
    });

    test("returns empty object when namespace has no entries", async () => {
      const result = await sessionGetAll("emptyNamespace");
      expect(result).toEqual({});
    });

    test("returns empty object when storage.session.get throws", async () => {
      sessionGetMock().mockRejectedValueOnce(new Error("unavailable"));

      const result = await sessionGetAll("reverseGeo");
      expect(result).toEqual({});
    });
  });

  describe("sessionClearNamespace", () => {
    test("removes all entries under a namespace", async () => {
      await sessionSet("timezone:a", "val1");
      await sessionSet("timezone:b", "val2");
      await sessionSet("reverseGeo:c", "val3");

      await sessionClearNamespace("timezone");

      const tzEntries = await sessionGetAll("timezone");
      expect(Object.keys(tzEntries)).toHaveLength(0);

      // Other namespaces should be untouched
      const geoEntries = await sessionGetAll("reverseGeo");
      expect(Object.keys(geoEntries)).toHaveLength(1);
    });

    test("does not throw when clearNamespace fails", async () => {
      await sessionSet("ns:key", "val");
      sessionRemoveMock().mockRejectedValueOnce(new Error("remove failed"));

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await expect(sessionClearNamespace("ns")).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    test("does nothing when namespace is empty", async () => {
      vi.clearAllMocks();
      await sessionClearNamespace("empty");
      // remove should not have been called since there are no keys to remove
      expect(sessionRemoveMock()).not.toHaveBeenCalled();
    });
  });
});
