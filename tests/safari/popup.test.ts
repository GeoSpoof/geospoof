/**
 * Safari's popup after the flip: the Filters and Per-site locations add
 * fields offer exact addresses, site groups and lists from a link, the "What
 * can I add?" rows for them show, and the Pro lock hides nothing new
 * (`data-site-groups-only` rows follow `siteGroupsAvailable()`, not the lock).
 * Also R3: the marker the app looks for ships exactly while Safari offers
 * the forms.
 */
import { describe, test, expect, beforeEach, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { siteGroupsAvailable } from "@/shared/site-groups/availability";

// Stub the reload so a successful add doesn't re-run the whole popup render.
vi.mock("@/popup/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/popup/settings")>();
  return { ...actual, loadSettings: vi.fn().mockResolvedValue(undefined) };
});

// Import order matters: scope first, so the settings mock is built before it binds.
import { __resetScopeForTest, renderScope } from "@/popup/scope";
import { createEntryAddControl } from "@/popup/entry-add-control";
import { __resetPopupSiteGroupsForTest, describeEntry } from "@/popup/site-groups";
import { __resetSiteLocationsForTest, renderSiteLocations } from "@/popup/site-locations";
import { EXACT, GOOGLE, LINK, LINK_URL, settingsWith } from "./helpers";

const BODY = (() => {
  const html = readFileSync("assets/popup.html", "utf8");
  return new DOMParser().parseFromString(html, "text/html").body.innerHTML;
})();

const INDEX = {
  release: "20261104112839",
  lists: [
    { name: "google", count: 964 },
    { name: "twitch", count: 35 },
  ],
};

const sendMessage = vi.mocked(browser.runtime.sendMessage);

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing`);
  return node as T;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function type(id: string, value: string): void {
  const input = byId<HTMLInputElement>(id);
  input.value = value;
  input.dispatchEvent(new Event("input"));
}

/** Each suggestion row of `listboxId` as "title · meta", and Browse by its text. */
function suggestions(listboxId: string): string[] {
  return Array.from(byId(listboxId).querySelectorAll<HTMLElement>("[role='option']")).map((o) => {
    const title = o.querySelector(".entry-suggestion-title")?.textContent;
    const meta = o.querySelector(".entry-suggestion-meta")?.textContent;
    return title === undefined ? (o.textContent ?? "") : `${title} · ${meta}`;
  });
}

function messagesOfType(type: string): unknown[] {
  return sendMessage.mock.calls
    .map(([message]) => message as unknown as { type: string; payload?: unknown })
    .filter((message) => message.type === type)
    .map((message) => message.payload);
}

/** Shown and hidden `data-site-groups-only` rows inside `rootId`. */
function siteGroupsOnlyRows(rootId: string): { shown: number; hidden: number } {
  const rows = Array.from(byId(rootId).querySelectorAll<HTMLElement>("[data-site-groups-only]"));
  return {
    shown: rows.filter((r) => !r.hidden).length,
    hidden: rows.filter((r) => r.hidden).length,
  };
}

const LINK_TITLE = describeEntry(LINK, { unsaved: true }).title;

beforeEach(() => {
  document.body.innerHTML = BODY;
  byId("mainView").style.display = "none";
  byId("filtersView").style.display = "block";
  byId("filtersRoot").hidden = true;
  byId("scopeListScreen").hidden = false;
  byId("scopeListContent").hidden = false;
  __resetScopeForTest();
  __resetPopupSiteGroupsForTest();
  __resetSiteLocationsForTest();
  sendMessage.mockReset();
  sendMessage.mockImplementation((message: unknown) => {
    const { type } = message as { type: string };
    if (type === "GET_SITE_GROUP_INDEX") return Promise.resolve(INDEX);
    if (type === "ADD_SCOPE_SITE") return Promise.resolve({ success: true });
    return Promise.resolve(undefined);
  });
});

describe("R3", () => {
  test("safari-forms.json ships exactly while Safari offers the forms", () => {
    expect(siteGroupsAvailable()).toBe(existsSync("assets/site-groups/safari-forms.json"));
  });

  test("this Safari build offers them", () => {
    expect(siteGroupsAvailable()).toBe(true);
  });
});

describe("Filters on Safari", () => {
  const open = () => renderScope(settingsWith({ scopeMode: "allowlist", allowlist: [] }));

  test("the field names sites and site groups", () => {
    open();
    expect(byId<HTMLInputElement>("scopeAddInput").placeholder).toBe(
      "Site or site group, e.g. twitch.tv"
    );
  });

  test("twitch.tv suggests the exact address, the Twitch group and Browse", async () => {
    open();
    type("scopeAddInput", "twitch.tv");
    await settle();
    expect(suggestions("scopeGroupListbox")).toEqual([
      "twitch.tv · Site and its subdomains",
      "twitch.tv · Exact address only",
      "*.twitch.tv · Subdomains only",
      "Twitch · Site group · 35 sites",
      "Browse all site groups…",
    ]);
  });

  test("a pasted list link suggests a list from a link", () => {
    open();
    type("scopeAddInput", LINK_URL);
    expect(suggestions("scopeGroupListbox")).toEqual([`${LINK_TITLE} · List from a link`]);
  });

  test.each([
    ["=Mail.Example.com", EXACT],
    ["GeoSite:Google", GOOGLE],
    [LINK_URL, LINK],
  ])("adding %s sends ADD_SCOPE_SITE with %s", async (typed, pattern) => {
    open();
    type("scopeAddInput", typed);
    byId<HTMLInputElement>("scopeAddInput").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
    );
    await settle();
    expect(messagesOfType("ADD_SCOPE_SITE")).toEqual([{ list: "allowlist", pattern }]);
  });

  test("'What can I add?' shows the exact, group, tag, link and list: rows", () => {
    open();
    expect(siteGroupsOnlyRows("scopeListScreen")).toEqual({ shown: 5, hidden: 0 });
  });
});

describe("Per-site locations on Safari", () => {
  const ids = {
    input: "siteLocationPatterns",
    button: "siteLocationAddEntry",
    listbox: "siteLocationGroupListbox",
    attribution: "siteLocationGroupAttribution",
    error: "siteLocationError",
  };
  const open = () => renderSiteLocations(settingsWith(), false, "https://example.com/");
  /** The editor's own control (one per element set). */
  const editorControl = () =>
    createEntryAddControl({
      ids,
      context: "siteLocation",
      onSubmit: () => Promise.resolve({ ok: true }),
    });

  test("the Sites field names sites and site groups", () => {
    open();
    expect(byId<HTMLInputElement>("siteLocationPatterns").placeholder).toBe(
      "Site or site group, e.g. twitch.tv"
    );
  });

  test("the field reads each form", () => {
    open();
    for (const [typed, entry] of [
      ["=mail.example.com", EXACT],
      ["geosite:google", GOOGLE],
      [LINK_URL, LINK],
    ]) {
      byId<HTMLInputElement>("siteLocationPatterns").value = typed;
      expect(editorControl()?.readPending()).toEqual({ entries: [entry], error: null });
    }
  });

  test("twitch.tv suggests the exact address and the Twitch group", async () => {
    open();
    editorControl();
    type("siteLocationPatterns", "twitch.tv");
    await settle();
    const rows = suggestions("siteLocationGroupListbox");
    expect(rows).toContain("twitch.tv · Exact address only");
    expect(rows).toContain("Twitch · Site group · 35 sites");
  });

  test("'What can I add?' lists every form", () => {
    open();
    const examples = Array.from(
      byId("siteLocationSyntax").querySelectorAll<HTMLElement>(".scope-syntax-row")
    )
      .filter((row) => !row.hidden)
      .map((row) => row.dataset.example);
    expect(examples).toEqual(
      expect.arrayContaining([
        "=mail.example.com",
        "geosite:google",
        "geosite:google@cn",
        "https://example.com/list.txt",
        "list:https://example.com/sites",
      ])
    );
    expect(siteGroupsOnlyRows("siteLocationSyntax")).toEqual({ shown: 5, hidden: 0 });
  });
});

describe("the Pro lock (proFeaturesBlocked, iOS and macOS)", () => {
  /** Every element's hidden and disabled state, by a stable path. */
  function states(): Map<string, string> {
    const out = new Map<string, string>();
    document.body.querySelectorAll<HTMLElement>("[id], .scope-mode-btn").forEach((node) => {
      const key = node.id ? `#${node.id}` : `mode:${node.dataset.scopeMode}`;
      const disabled = (node as HTMLInputElement).disabled === true;
      out.set(key, `${node.hidden ? "hidden" : "shown"}/${disabled ? "disabled" : "enabled"}`);
    });
    return out;
  }

  function render(locked: boolean): Map<string, string> {
    document.body.innerHTML = BODY;
    __resetScopeForTest();
    __resetSiteLocationsForTest();
    const settings = settingsWith({
      scopeMode: "allowlist",
      allowlist: [GOOGLE],
      proFeaturesBlocked: locked,
    });
    renderScope(settings, locked);
    renderSiteLocations(settings, locked, "https://example.com/");
    return states();
  }

  test("changes only the controls it locked before the flip, and no site group row", () => {
    const unlocked = render(false);
    const locked = render(true);
    const changed = [...locked].filter(([key, state]) => unlocked.get(key) !== state);
    // Design H's locked state: the mode buttons, the Pro note in place of the
    // description, the list content, and the add controls. Nothing for site groups.
    expect(changed.map(([key]) => key)).toEqual([
      "#scopeModeAll",
      "#scopeModeAllowlist",
      "#scopeModeDenylist",
      "#scopeModeDesc",
      "#scopeProNote",
      "#scopeListContent",
      "#scopeAddSiteButton",
      "#scopeAddInput",
      "#scopeAddButton",
      "#siteLocationsAddButton",
    ]);
    for (const row of document.querySelectorAll<HTMLElement>("[data-site-groups-only]")) {
      expect(row.hidden).toBe(false);
    }
  });
});
