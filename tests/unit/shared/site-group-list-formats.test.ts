import { describe, it, expect } from "vitest";
import { parseDomainList, type ParsedDomainList } from "@/shared/site-groups/list-formats";

function parse(text: string, maxEntries?: number): ParsedDomainList {
  const result = parseDomainList(text, maxEntries === undefined ? {} : { maxEntries });
  if ("error" in result) {
    throw new Error(result.error);
  }
  return result;
}

describe("parseDomainList", () => {
  it("reads plain lines as domains", () => {
    expect(parse("example.com\nfoo.example.org\n")).toEqual({
      domains: ["example.com", "foo.example.org"],
      fulls: [],
      skipped: { regexp: 0, keyword: 0, other: 0 },
    });
  });

  it("reads v2fly domain:, full:, regexp:, keyword: and include:", () => {
    const r = parse(
      "domain:google.com\nfull:www.google.com\nregexp:^a$\nkeyword:goog\ninclude:youtube\n"
    );
    expect(r.domains).toEqual(["google.com"]);
    expect(r.fulls).toEqual(["www.google.com"]);
    expect(r.skipped).toEqual({ regexp: 1, keyword: 1, other: 1 });
  });

  it("strips v2fly attrs in both spellings", () => {
    const r = parse("google.cn @cn\ndomain:a.cn @cn @ads\nfull:b.cn:@cn,@ads\n");
    expect(r.domains).toEqual(["google.cn", "a.cn"]);
    expect(r.fulls).toEqual(["b.cn"]);
  });

  it("reads Clash classical rules, ignoring a policy field", () => {
    const r = parse(
      "DOMAIN-SUFFIX,google.com\ndomain,www.example.com,PROXY\nDOMAIN-KEYWORD,goog\nDOMAIN-REGEX,^x$\nIP-CIDR,1.1.1.1/32\nGEOSITE,cn\n"
    );
    expect(r.domains).toEqual(["google.com"]);
    expect(r.fulls).toEqual(["www.example.com"]);
    expect(r.skipped).toEqual({ regexp: 1, keyword: 1, other: 2 });
  });

  it("mihomo +. lines make plain lines exact", () => {
    const r = parse("+.google.com\nwww.example.com\n");
    expect(r.domains).toEqual(["google.com"]);
    expect(r.fulls).toEqual(["www.example.com"]);
  });

  it("plain lines stay domains without any +. line", () => {
    expect(parse("www.example.com\n").domains).toEqual(["www.example.com"]);
  });

  it("unwraps a YAML payload", () => {
    const r = parse(
      "payload:\n  - '+.google.com'\n  - \"api.example.com\"\n  - DOMAIN-SUFFIX,x.com\n"
    );
    expect(r.domains).toEqual(["google.com", "x.com"]);
    expect(r.fulls).toEqual(["api.example.com"]);
  });

  it("strips comments, a BOM and CRLF", () => {
    const r = parse("\uFEFF# header\r\nexample.com # note\r\n\r\n#example.org\r\nfoo.com\r");
    expect(r.domains).toEqual(["example.com", "foo.com"]);
    expect(r.skipped.other).toBe(0);
  });

  it("converts IDN hosts to A-labels and lowercases", () => {
    expect(parse("MÜNCHEN.de\nExample.COM\n").domains).toEqual([
      "xn--mnchen-3ya.de",
      "example.com",
    ]);
  });

  it("dedupes", () => {
    const r = parse("a.com\nA.com\ndomain:a.com\nfull:a.com\nDOMAIN,a.com\n");
    expect(r.domains).toEqual(["a.com"]);
    expect(r.fulls).toEqual(["a.com"]);
  });

  it.each([
    "*.example.com",
    ".example.com",
    "bad_host.com",
    "-a.com",
    "a.com.",
    "0.0.0.0 a.com",
    "a".repeat(64) + ".com",
  ])("counts %s as other", (line) => {
    const r = parse(`${line}\n`);
    expect(r.domains).toEqual([]);
    expect(r.fulls).toEqual([]);
    expect(r.skipped.other).toBe(1);
  });

  it("returns empty for an empty file", () => {
    expect(parse("")).toEqual({
      domains: [],
      fulls: [],
      skipped: { regexp: 0, keyword: 0, other: 0 },
    });
  });

  it("enforces the entry cap on unique entries", () => {
    expect(parseDomainList("a.com\nb.com\nc.com\n", { maxEntries: 2 })).toEqual({
      error: "TOO_LARGE",
    });
    expect(parse("a.com\nb.com\na.com\n", 2).domains).toEqual(["a.com", "b.com"]);
  });

  it("has a 250,000 entry default cap", () => {
    const lines = Array.from({ length: 250_001 }, (_, i) => `h${i}.com`).join("\n");
    expect(parseDomainList(lines)).toEqual({ error: "TOO_LARGE" });
  });
});
