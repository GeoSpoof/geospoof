import { describe, test, expect } from "vitest";
import { hostToASCII } from "@/shared/utils/idn";

/**
 * Unit coverage for the IDN host → A-label helper (idn-pattern-support Req 4).
 * `hostToASCII` is the single wrapper around `tr46.toASCII`; it must convert
 * Unicode hosts to their Punycode form, no-op on ASCII, round-trip pre-encoded
 * `xn--` hosts, and fail safe (return `null`, never throw) on invalid input.
 *
 * Expected A-label values are independently verified against `tr46@7.0.0` with
 * the WHATWG-URL "domain to ASCII" option set, so this also pins the helper's
 * option choices.
 */
describe("idn: hostToASCII", () => {
  test("converts Unicode hosts to their A-label (Punycode) form", () => {
    expect(hostToASCII("münchen.de")).toBe("xn--mnchen-3ya.de");
    expect(hostToASCII("日本.jp")).toBe("xn--wgv71a.jp");
    expect(hostToASCII("пример.рф")).toBe("xn--e1afmkfd.xn--p1ai");
    expect(hostToASCII("café.fr")).toBe("xn--caf-dma.fr");
  });

  test("is a no-op on ASCII hosts and localhost", () => {
    expect(hostToASCII("example.com")).toBe("example.com");
    expect(hostToASCII("sub.example.co.uk")).toBe("sub.example.co.uk");
    expect(hostToASCII("localhost")).toBe("localhost");
  });

  test("round-trips an already-encoded xn-- host unchanged (idempotent)", () => {
    expect(hostToASCII("xn--mnchen-3ya.de")).toBe("xn--mnchen-3ya.de");
    expect(hostToASCII("xn--wgv71a.jp")).toBe("xn--wgv71a.jp");
    // toASCII(toASCII(unicode)) === toASCII(unicode)
    const once = hostToASCII("münchen.de");
    expect(once).not.toBeNull();
    expect(hostToASCII(once as string)).toBe(once);
  });

  test("returns null on invalid IDN input rather than throwing", () => {
    // A label may not begin with a combining mark (UTS #46 validity rule 6).
    expect(hostToASCII("\u0300example.com")).toBeNull();
    // Empty host is not a usable A-label.
    expect(hostToASCII("")).toBeNull();
  });
});
