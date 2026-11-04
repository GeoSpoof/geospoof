/**
 * Filters tab with site groups (GeoSpoof/geospoof#206): exact, group and link
 * rows, adding through the shared control with the background's error codes,
 * removing a group row, and the site group status line with "Update now".
 */

import { describe, test, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Settings } from "@/shared/types/settings";
import { DEFAULT_SETTINGS } from "@/shared/types/settings";
import { makeSiteLocation } from "../../helpers/site-locations";

const gate = vi.hoisted(() => ({ available: true }));
vi.mock("@/shared/site-groups/availability", () => ({
  siteGroupsAvailable: () => gate.available,
}));

// Stub the reload so a successful action doesn't re-run the whole popup render.
vi.mock("@/popup/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/popup/settings")>();
  return { ...actual, loadSettings: vi.fn().mockResolvedValue(undefined) };
});

// Import order matters: scope first, so the settings mock is built before it binds.
import { __resetScopeForTest, renderScope } from "@/popup/scope";
import { loadSettings } from "@/popup/settings";
import {
  __resetPopupSiteGroupsForTest,
  formatCatalogDate,
  formatCount,
  loadPopupSiteGroups,
} from "@/popup/site-groups";

const BODY = (() => {
  const html = readFileSync("assets/popup.html", "utf8");
  return new DOMParser().parseFromString(html, "text/html").body.innerHTML;
})();

const sendMessage = vi.mocked(browser.runtime.sendMessage);

const LINK_URL =
  "https://raw.githubusercontent.com/Loyalsoldier/v2ray-rules-dat/release/direct-list.txt";
const LINK = `list:${LINK_URL}`;
const GOOGLE = "geosite:google";

const STATUS = {
  release: "20261104112839",
  releasedAt: "2026-11-04T11:28:50Z",
  checkedAt: 1_700_000_000_000,
  lastError: null as "NETWORK" | "INVALID" | null,
  updating: false,
};
const DATE = formatCatalogDate(Date.parse(STATUS.releasedAt));

const GROUPS = {
  [GOOGLE]: {
    token: GOOGLE,
    kind: "group",
    name: "google",
    count: 964,
    skipped: 2,
    updatedAt: 1,
    d: "\ngoogle.com\n",
    f: "\n",
  },
  [LINK]: {
    token: LINK,
    kind: "link",
    name: "direct-list",
    count: 110_197,
    skipped: 8,
    updatedAt: 1,
    d: "\nexample.cn\n",
    f: "\n",
  },
};

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, enabled: true, ...overrides };
}

const ALLOW = makeSettings({
  scopeMode: "allowlist",
  allowlist: ["example.com", "=mail.example.com", GOOGLE, LINK],
});

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing`);
  return node as T;
}

/** Load the popup's site group data as loadSettings does. */
async function loadGroups(
  settings: Settings,
  groups: Record<string, unknown> = GROUPS,
  status: typeof STATUS = STATUS
): Promise<void> {
  sendMessage.mockResolvedValueOnce({ available: true, status, groups });
  await loadPopupSiteGroups(settings);
}

async function render(
  settings: Settings,
  groups: Record<string, unknown> = GROUPS,
  status = STATUS
): Promise<void> {
  await loadGroups(settings, groups, status);
  renderScope(settings);
  sendMessage.mockReset();
}

function rows(): HTMLElement[] {
  return Array.from(byId("scopeList").children) as HTMLElement[];
}

function rowFor(title: string): HTMLElement {
  const row = rows().find((r) => r.querySelector(".scope-site-domain")?.textContent === title);
  if (!row) throw new Error(`no row ${title}`);
  return row;
}

function messagesOfType(type: string): unknown[] {
  return sendMessage.mock.calls
    .map(([message]) => message as unknown as { type: string; payload?: unknown })
    .filter((message) => message.type === type)
    .map((message) => message.payload);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function statusText(): string {
  return (byId("siteGroupsStatusText").textContent ?? "").trim();
}

beforeEach(() => {
  gate.available = true;
  document.body.innerHTML = BODY;
  byId("mainView").style.display = "none";
  byId("filtersView").style.display = "block";
  __resetScopeForTest();
  __resetPopupSiteGroupsForTest();
  sendMessage.mockReset();
  vi.mocked(loadSettings).mockReset();
  vi.mocked(loadSettings).mockResolvedValue(undefined);
});

describe("rows", () => {
  test("typed rows render exactly as before", async () => {
    await render(ALLOW);
    const row = rowFor("example.com");
    expect(Array.from(row.children).map((c) => c.className)).toEqual([
      "scope-site-icon",
      "scope-site-domain",
      "scope-site-remove",
    ]);
    expect(row.querySelector(".scope-site-domain")?.getAttribute("title")).toBe("example.com");
    expect(row.querySelector(".scope-site-remove")?.getAttribute("aria-label")).toBe(
      "Remove site example.com"
    );
  });

  test("an exact address, a group and a link are one row each, with a meta line", async () => {
    await render(ALLOW);
    expect(rows()).toHaveLength(4);
    expect(byId("scopeListCount").textContent).toBe("4");

    const meta = (title: string) => rowFor(title).querySelector(".scope-site-meta")?.textContent;
    expect(meta("mail.example.com")).toBe("Exact address only");
    expect(meta("Google")).toBe("964 sites");
    expect(meta("direct-list")).toBe(
      `${formatCount(110_197)} sites · from raw.githubusercontent.com · 8 rules skipped`
    );

    const link = rowFor("direct-list");
    expect(link.querySelector(".scope-site-domain")?.getAttribute("title")).toBe(LINK_URL);
    expect(link.querySelector(".scope-site-icon")?.textContent).toBe("D");
    expect(rowFor("Google").querySelector(".scope-site-remove")?.getAttribute("aria-label")).toBe(
      "Remove site Google"
    );
    expect(rowFor("Google").querySelector(".scope-site-domain")?.getAttribute("title")).toBe(
      GOOGLE
    );
    expect(rows().every((r) => r.getAttribute("role") === "listitem")).toBe(true);
  });

  test("a group with no data says 'Not available' with a warning sign", async () => {
    await render(ALLOW, { [LINK]: GROUPS[LINK] });
    const meta = rowFor("Google").querySelector(".scope-site-meta")!;
    expect(meta.classList.contains("warning")).toBe(true);
    expect(meta.textContent).toBe("⚠ Not available");
    expect(meta.querySelector("[aria-hidden='true']")?.textContent).toBe("⚠ ");
    expect(rowFor("direct-list").querySelector(".scope-site-meta.warning")).toBeNull();
  });

  test("a warning meta line is coloured text, not the global .warning banner box", () => {
    const css = readFileSync("assets/popup.css", "utf8");
    for (const selector of [".scope-site-meta.warning", ".entry-chip-meta.warning"]) {
      const escaped = selector.replace(/\./g, "\\.");
      const rule = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
      expect(rule).toContain("background: none");
      expect(rule).toContain("border: 0");
      expect(rule).toContain("padding: 0");
      expect(rule).toMatch(/font-size: (12px|inherit)/);
    }
  });

  test("a link whose last refresh failed says so, in the warning style", async () => {
    await render(ALLOW, { ...GROUPS, [LINK]: { ...GROUPS[LINK], lastError: "LINK_FAILED" } });
    const meta = rowFor("direct-list").querySelector(".scope-site-meta")!;
    expect(meta.classList.contains("warning")).toBe(true);
    expect(meta.textContent).toBe("⚠ Couldn't update this list");
  });
});

describe("adding", () => {
  function typeAndEnter(value: string): void {
    const input = byId<HTMLInputElement>("scopeAddInput");
    input.value = value;
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }

  test("a group sends ADD_SCOPE_SITE with its canonical token, then reloads", async () => {
    await render(makeSettings({ scopeMode: "denylist", denylist: [] }));
    sendMessage.mockResolvedValue({ success: true, siteGroup: { count: 964, skipped: 2 } });
    typeAndEnter("GeoSite:Google@CN");
    await flush();
    expect(messagesOfType("ADD_SCOPE_SITE")).toEqual([
      { list: "denylist", pattern: "geosite:google@cn" },
    ]);
    expect(loadSettings).toHaveBeenCalledTimes(1);
    expect(byId<HTMLInputElement>("scopeAddInput").value).toBe("");
  });

  test("an exact address sends its = form", async () => {
    await render(makeSettings({ scopeMode: "allowlist", allowlist: [] }));
    sendMessage.mockResolvedValue({ success: true });
    typeAndEnter("=Mail.Example.com");
    await flush();
    expect(messagesOfType("ADD_SCOPE_SITE")).toEqual([
      { list: "allowlist", pattern: "=mail.example.com" },
    ]);
  });

  test.each<[string, string, Record<string, unknown>, string]>([
    [
      "UNKNOWN_GROUP",
      "geosite:googel",
      { token: "geosite:googel" },
      "No site group is called googel.",
    ],
    [
      "EMPTY_GROUP",
      "geosite:google@zz",
      { token: "geosite:google@zz" },
      "Google has no sites with that tag.",
    ],
    [
      "LINK_FAILED",
      LINK_URL,
      { token: LINK },
      "Couldn't download that list. Check the link and try again.",
    ],
    [
      "LINK_EMPTY",
      LINK_URL,
      { token: LINK, skipped: 3 },
      "That list has no sites GeoSpoof can use.",
    ],
    [
      "LINK_TOO_LARGE",
      LINK_URL,
      { token: LINK },
      `That list is too large. GeoSpoof supports up to ${formatCount(250_000)} sites per list.`,
    ],
    [
      "STORAGE_FULL",
      "geosite:google",
      { token: GOOGLE },
      "Site groups are out of space. Remove a large list first.",
    ],
    ["INVALID_PATTERN", "geosite:google", {}, "No site group is called google."],
    ["STORAGE_ERROR", "example.com", {}, "⚠ Change not saved"],
  ])("%s keeps the text and shows its message", async (error, value, extra, message) => {
    await render(makeSettings({ scopeMode: "allowlist", allowlist: [] }));
    sendMessage.mockResolvedValue({ error, ...extra });
    typeAndEnter(value);
    await flush();
    const alert = byId("scopeAddError");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.style.display).toBe("block");
    expect(alert.textContent).toBe(message);
    expect(byId<HTMLInputElement>("scopeAddInput").value).toBe(value);
    expect(loadSettings).not.toHaveBeenCalled();
  });

  test("a failed send says the change wasn't saved", async () => {
    await render(makeSettings({ scopeMode: "allowlist", allowlist: [] }));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    sendMessage.mockRejectedValue(new Error("disconnected"));
    typeAndEnter("geosite:google");
    await flush();
    expect(byId("scopeAddError").textContent).toBe("⚠ Change not saved");
    spy.mockRestore();
  });

  test.each([
    [{ count: 110_197, skipped: 0 }, `Added direct-list: ${formatCount(110_197)} sites.`],
    [{ count: 5, skipped: 8 }, "Added direct-list: 5 sites, 8 rules skipped."],
  ])("a link add announces what it added (%j)", async (siteGroup, announcement) => {
    await render(makeSettings({ scopeMode: "allowlist", allowlist: [] }));
    sendMessage.mockResolvedValue({ success: true, siteGroup });
    typeAndEnter(LINK_URL);
    await flush();
    expect(messagesOfType("ADD_SCOPE_SITE")).toEqual([{ list: "allowlist", pattern: LINK }]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(byId("siteLocationAnnouncer").textContent).toBe(announcement);
  });

  test("switching lists clears what was typed for the other one", async () => {
    await render(makeSettings({ scopeMode: "allowlist", allowlist: [] }));
    const input = byId<HTMLInputElement>("scopeAddInput");
    input.value = "geosite:google";
    input.dispatchEvent(new Event("input"));
    renderScope(makeSettings({ scopeMode: "allowlist", allowlist: [] }));
    expect(input.value).toBe("geosite:google");
    renderScope(makeSettings({ scopeMode: "denylist", denylist: [] }));
    expect(input.value).toBe("");
    expect(byId<HTMLSelectElement>("scopeAddKind").value).toBe("site");
  });
});

describe("removing a group row", () => {
  test("sends its token, and a failure puts the row back as it was", async () => {
    await render(ALLOW);
    sendMessage.mockResolvedValue({ error: "STORAGE_ERROR" });
    rowFor("Google").querySelector<HTMLButtonElement>(".scope-site-remove")!.click();
    expect(rows()).toHaveLength(3);
    expect(byId("scopeListCount").textContent).toBe("3");
    await flush();

    expect(messagesOfType("REMOVE_SCOPE_SITE")).toEqual([{ list: "allowlist", pattern: GOOGLE }]);
    expect(rows()).toHaveLength(4);
    expect(rows()[2].querySelector(".scope-site-domain")?.textContent).toBe("Google");
    expect(rows()[2].querySelector(".scope-site-meta")?.textContent).toBe("964 sites");
    expect(byId("scopeModeError").style.display).toBe("block");
  });

  test("a successful remove reloads", async () => {
    await render(ALLOW);
    sendMessage.mockResolvedValue({ success: true });
    rowFor("direct-list").querySelector<HTMLButtonElement>(".scope-site-remove")!.click();
    await flush();
    expect(messagesOfType("REMOVE_SCOPE_SITE")).toEqual([{ list: "allowlist", pattern: LINK }]);
    expect(loadSettings).toHaveBeenCalledTimes(1);
  });
});

describe("the site group status line", () => {
  test("is a polite status with an Update now button", () => {
    expect(byId("siteGroupsStatusText").getAttribute("role")).toBe("status");
    expect(byId("siteGroupsStatusText").getAttribute("aria-live")).toBe("polite");
    expect(byId<HTMLButtonElement>("siteGroupsUpdateNow").type).toBe("button");
    expect(byId("siteGroupsStatus").hidden).toBe(true);
  });

  test("stays hidden when nothing uses a site group", async () => {
    await render(makeSettings({ scopeMode: "allowlist", allowlist: ["example.com"] }));
    expect(byId("siteGroupsStatus").hidden).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("names the date of the lists in use", async () => {
    await render(ALLOW);
    expect(byId("siteGroupsStatus").hidden).toBe(false);
    expect(statusText()).toBe(`Site group lists from ${DATE}`);
  });

  test("shows in 'All sites' mode when a site location uses a group", async () => {
    const settings = makeSettings({
      scopeMode: "all",
      siteLocations: [makeSiteLocation({ patterns: ["twitch.tv", GOOGLE] })],
    });
    await render(settings);
    expect(byId("scopeListManager").style.display).toBe("none");
    expect(byId("siteGroupsStatus").hidden).toBe(false);
    expect(statusText()).toBe(`Site group lists from ${DATE}`);
  });

  test("hides when only the inactive list uses a group", async () => {
    await render(makeSettings({ scopeMode: "denylist", denylist: [], allowlist: [GOOGLE] }));
    expect(byId("siteGroupsStatus").hidden).toBe(true);
  });

  test("says when the last update failed, and while one runs", async () => {
    await render(ALLOW, GROUPS, { ...STATUS, lastError: "NETWORK" });
    expect(statusText()).toBe(`Couldn't update site groups. Using lists from ${DATE}.`);
    await render(ALLOW, GROUPS, { ...STATUS, updating: true });
    expect(statusText()).toBe("Updating site groups…");
  });

  test("Update now refreshes, then reports up to date when nothing changed", async () => {
    await render(ALLOW);
    let finish: (value: unknown) => void = () => {};
    sendMessage.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    vi.mocked(loadSettings).mockImplementationOnce(async () => {
      await loadGroups(ALLOW);
      renderScope(ALLOW);
    });

    const button = byId("siteGroupsUpdateNow");
    button.click();
    expect(messagesOfType("UPDATE_SITE_GROUPS")).toEqual([undefined]);
    expect(statusText()).toBe("Updating site groups…");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    // A second press meanwhile does nothing.
    button.click();
    expect(messagesOfType("UPDATE_SITE_GROUPS")).toHaveLength(1);

    finish({ success: true, status: STATUS });
    await flush();
    expect(loadSettings).toHaveBeenCalledTimes(1);
    expect(statusText()).toBe(`Site groups are up to date (lists from ${DATE})`);
    expect(button.hasAttribute("aria-disabled")).toBe(false);
  });

  test("Update now that finds newer lists shows their date", async () => {
    await render(ALLOW);
    const newer = { ...STATUS, release: "20261111000000", releasedAt: "2026-11-11T00:00:00Z" };
    sendMessage.mockResolvedValueOnce({ success: true, status: newer });
    vi.mocked(loadSettings).mockImplementationOnce(async () => {
      await loadGroups(ALLOW, GROUPS, newer);
      renderScope(ALLOW);
    });
    byId("siteGroupsUpdateNow").click();
    await flush();
    expect(statusText()).toBe(
      `Site group lists from ${formatCatalogDate(Date.parse(newer.releasedAt))}`
    );
  });

  test("Update now that fails shows the failure after the reload", async () => {
    await render(ALLOW);
    const failed = { ...STATUS, lastError: "NETWORK" as const };
    sendMessage.mockResolvedValueOnce({ error: "NETWORK", status: failed });
    vi.mocked(loadSettings).mockImplementationOnce(async () => {
      await loadGroups(ALLOW, GROUPS, failed);
      renderScope(ALLOW);
    });
    byId("siteGroupsUpdateNow").click();
    await flush();
    expect(statusText()).toBe(`Couldn't update site groups. Using lists from ${DATE}.`);
  });
});

describe("the Pro lock and the Safari gate", () => {
  test("the Pro lock also disables the type menu", async () => {
    await render(ALLOW);
    renderScope(ALLOW, true);
    expect(byId<HTMLSelectElement>("scopeAddKind").disabled).toBe(true);
    renderScope(ALLOW, false);
    expect(byId<HTMLSelectElement>("scopeAddKind").disabled).toBe(false);
  });

  test("the syntax rows for the new forms show only where they can be added", () => {
    renderScope(ALLOW);
    const rowsOnly = Array.from(document.querySelectorAll<HTMLElement>("[data-site-groups-only]"));
    expect(rowsOnly.map((r) => r.querySelector("code")?.textContent)).toEqual([
      "=mail.example.com",
      "geosite:google",
      "geosite:google@cn",
      "https://…/list.txt",
    ]);
    expect(rowsOnly.every((r) => !r.hidden)).toBe(true);

    document.body.innerHTML = BODY;
    gate.available = false;
    renderScope(ALLOW);
    expect(
      Array.from(document.querySelectorAll<HTMLElement>("[data-site-groups-only]")).every(
        (r) => r.hidden
      )
    ).toBe(true);
    expect(Array.from(byId<HTMLSelectElement>("scopeAddKind").options).map((o) => o.value)).toEqual(
      ["site", "subdomains"]
    );
  });

  test("where site groups are unavailable, stored tokens ask nothing and show no status", () => {
    gate.available = false;
    expect(loadPopupSiteGroups(ALLOW)).toBeNull();
    renderScope(ALLOW);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(byId("siteGroupsStatus").hidden).toBe(true);
  });
});
