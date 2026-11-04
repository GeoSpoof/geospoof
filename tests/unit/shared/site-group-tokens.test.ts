import { describe, it, expect } from "vitest";
import {
  isSiteGroupToken,
  linkDisplayName,
  parseGroupToken,
  parseLinkToken,
} from "@/shared/site-groups/tokens";

describe("parseGroupToken", () => {
  it.each([
    ["geosite:google", "geosite:google"],
    ["GEOSITE:GOOGLE", "geosite:google"],
    ["  geosite:google  ", "geosite:google"],
    ["geosite:google@cn", "geosite:google@cn"],
    ["geosite:google@cn@ads", "geosite:google@ads@cn"],
    ["geosite:google@ads@cn@ads", "geosite:google@ads@cn"],
    ["geosite:geolocation-!cn", "geosite:geolocation-!cn"],
    ["geosite:category-ai-!cn@!cn", "geosite:category-ai-!cn@!cn"],
    [`geosite:${"a".repeat(64)}@${"b".repeat(32)}`, `geosite:${"a".repeat(64)}@${"b".repeat(32)}`],
  ])("%s → %s", (input, token) => {
    expect(parseGroupToken(input)?.token).toBe(token);
  });

  it("returns the name and sorted attrs", () => {
    expect(parseGroupToken("geosite:Apple@CN@ads")).toEqual({
      kind: "group",
      token: "geosite:apple@ads@cn",
      name: "apple",
      attrs: ["ads", "cn"],
    });
  });

  it.each([
    "google",
    "geosite:",
    "geosite:@cn",
    "geosite:google@",
    "geosite:google@@cn",
    "geosite:goo gle",
    "geosite:google_inc",
    "geosite:google.com",
    "geosite:google@c.n",
    "geo site:google",
    `geosite:${"a".repeat(65)}`,
    `geosite:google@${"a".repeat(33)}`,
    `geosite:google${"@a".repeat(1100)}`,
  ])("rejects %s", (input) => {
    expect(parseGroupToken(input)).toBeNull();
  });
});

describe("parseLinkToken", () => {
  it.each([
    ["https://example.org/a.txt", "list:https://example.org/a.txt"],
    ["list:https://example.org/a.txt", "list:https://example.org/a.txt"],
    ["LIST:https://example.org/a.txt", "list:https://example.org/a.txt"],
    ["  list: https://example.org/a.txt  ", "list:https://example.org/a.txt"],
    ["https://Example.ORG/A.txt", "list:https://example.org/A.txt"],
    ["https://example.org/a.txt#section", "list:https://example.org/a.txt"],
    ["https://example.org/a.txt?ref=1", "list:https://example.org/a.txt?ref=1"],
    ["https://example.org", "list:https://example.org/"],
    ["https://münchen.de/x.list", "list:https://xn--mnchen-3ya.de/x.list"],
  ])("%s → %s", (input, token) => {
    expect(parseLinkToken(input)?.token).toBe(token);
  });

  it("returns the url without the prefix", () => {
    expect(parseLinkToken("list:https://example.org/a.txt")).toEqual({
      kind: "link",
      token: "list:https://example.org/a.txt",
      url: "https://example.org/a.txt",
    });
  });

  it.each([
    "http://example.org/a.txt",
    "list:http://example.org/a.txt",
    "ftp://example.org/a.txt",
    "https://user@example.org/a.txt",
    "https://user:pw@example.org/a.txt",
    "list:",
    "list:not a url",
    "example.org/a.txt",
    "file:///etc/hosts",
    `https://example.org/${"a".repeat(2030)}`,
  ])("rejects %s", (input) => {
    expect(parseLinkToken(input)).toBeNull();
  });
});

describe("isSiteGroupToken", () => {
  it.each([
    ["geosite:google", true],
    ["list:https://example.org/a.txt", true],
    ["=example.com", false],
    ["example.com", false],
    ["https://example.org/a.txt", false],
    ["GEOSITE:google", false],
  ])("%s → %s", (entry, expected) => {
    expect(isSiteGroupToken(entry)).toBe(expected);
  });
});

describe("linkDisplayName", () => {
  it.each([
    [
      "https://raw.githubusercontent.com/Loyalsoldier/v2ray-rules-dat/release/direct-list.txt",
      "direct-list",
    ],
    ["list:https://example.org/lists/proxy.list", "proxy"],
    ["https://example.org/rules/streaming.yaml", "streaming"],
    ["https://example.org/rules/streaming.YML", "streaming"],
    ["https://example.org/rules/clash.conf", "clash"],
    ["https://example.org/rules/no-extension", "no-extension"],
    ["https://example.org/a/b/", "b"],
    ["https://example.org/my%20list.txt", "my list"],
    ["https://example.org/bad%E0%A4%A.txt", "bad%E0%A4%A"],
    ["https://example.org/", "example.org"],
    ["https://example.org/.txt", "example.org"],
    [`https://example.org/${"x".repeat(80)}.txt`, "x".repeat(60)],
  ])("%s → %s", (url, name) => {
    expect(linkDisplayName(url)).toBe(name);
  });
});
