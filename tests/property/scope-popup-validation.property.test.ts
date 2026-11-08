/**
 * Property + unit tests for the popup Filters tab (site-scoping UI).
 *
 * Mirrors the structure of popup-validation.property.test.ts. Covers:
 *   - inline parse validation on manual add (Req 12.3, 14.2, 14.4)
 *   - the root's list row, and "＋ Add <site>" on the list screen
 *   - the empty-list indicator (Req 14.8)
 *   - optimistic update + revert-on-failure for mode change and remove
 *     (Req 13.4, 13.5, 14.6, 9.5)
 *
 * Feature: site-scoping
 */

import fs from "fs";
import path from "path";
import fc from "fast-check";
import type { Settings } from "@/shared/types/settings";
import { __resetScopeForTest, renderScope, renderScopeLoadError } from "@/popup/scope";
import { parsePattern } from "@/shared/utils/scope";

/** Build a minimal full Settings object for the popup to render. */
function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    enabled: true,
    location: null,
    timezone: null,
    locationName: null,
    webrtcProtection: false,
    preserveGeolocationPrompt: false,
    onboardingCompleted: true,
    version: "1.1",
    lastUpdated: 0,
    vpnSyncEnabled: false,
    debuggerModeEnabled: false,
    autoSyncBlocked: false,
    proFeaturesBlocked: false,
    debugLogging: false,
    verbosityLevel: "INFO",
    theme: "system",
    uiLanguage: "",
    favorites: [],
    scopeMode: "all",
    allowlist: [],
    denylist: [],
    accuracySetting: { mode: "auto" },
    accuracySeed: 0,
    locationPrecision: { mode: "exact" },
    precisionSeed: 0,
    precisionCadence: "never" as const,
    localeSpoofing: { mode: "off" as const },
    siteLocations: [],
    ...overrides,
  };
}

/** Flush pending microtasks/macrotasks so async handlers settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function loadPopupDom(): void {
  const html = fs.readFileSync(path.join(__dirname, "../../assets/popup.html"), "utf8");
  document.documentElement.innerHTML = html;
}

describe("Popup Filters tab — scope mode selector (Req 13)", () => {
  beforeEach(() => {
    loadPopupDom();
    vi.mocked(browser.tabs.query).mockResolvedValue([]);
  });

  test("reflects the loaded scopeMode as the selected button (Req 13.1, 13.2)", () => {
    renderScope(makeSettings({ scopeMode: "denylist", denylist: [] }));

    const all = document.getElementById("scopeModeAll")!;
    const allow = document.getElementById("scopeModeAllowlist")!;
    const deny = document.getElementById("scopeModeDenylist")!;

    expect(deny.classList.contains("active")).toBe(true);
    expect(deny.getAttribute("aria-checked")).toBe("true");
    expect(all.classList.contains("active")).toBe(false);
    expect(allow.classList.contains("active")).toBe(false);
  });

  test("in 'all' mode the Filters row reads All sites and the screen has no list (Req 13.8)", () => {
    renderScope(makeSettings({ scopeMode: "all" }));
    expect(document.getElementById("scopeListCard")!.hidden).toBe(false);
    expect(document.getElementById("scopeListRowValue")!.textContent).toBe("All sites");
    expect(document.getElementById("scopeListRowDesc")!.textContent).toBe("All sites");
    expect(document.getElementById("scopeListContent")!.hidden).toBe(true);
  });

  test("shows the active list's row in list modes (Req 13.6, 13.7)", () => {
    renderScope(makeSettings({ scopeMode: "allowlist", allowlist: [] }));
    expect(document.getElementById("scopeListCard")!.hidden).toBe(false);
    expect(document.getElementById("scopeListRowTitle")!.textContent).toBe("Filters");
    expect(document.getElementById("scopeListContent")!.hidden).toBe(false);
    expect(document.getElementById("scopeListName")!.textContent).toBe("Allowlist");
  });

  // Property: in a list mode the row names the list and counts its entries,
  // and in All sites mode there's no row.
  test("the row shows the entry count and is described in words, or warns when empty", () => {
    const entries = fc.uniqueArray(fc.constantFrom("a.com", "b.org", "*.ru", "=c.net", "d.io"), {
      maxLength: 5,
    });
    fc.assert(
      fc.property(
        fc.constantFrom("all", "allowlist", "denylist") as fc.Arbitrary<Settings["scopeMode"]>,
        entries,
        (mode, list) => {
          loadPopupDom();
          renderScope(makeSettings({ scopeMode: mode, allowlist: list, denylist: list }));
          const card = document.getElementById("scopeListCard")!;
          const value = document.getElementById("scopeListRowValue")!;
          const desc = document.getElementById("scopeListRowDesc")!;
          expect(card.hidden).toBe(false);
          if (mode === "all") {
            expect(value.textContent).toBe("All sites");
            return;
          }
          const name = mode === "allowlist" ? "Allowlist" : "Denylist";
          const warn = mode === "allowlist" && list.length === 0;
          expect(value.textContent).toBe(
            warn ? "⚠ Empty · Off on every site" : `${name} · ${list.length}`
          );
          const words =
            list.length > 0
              ? `${list.length} on the list`
              : warn
                ? "Empty, Off on every site"
                : "Empty";
          // Spoken, so " · " reads as a comma (spokenValue).
          expect(desc.textContent).toBe(`${name}: ${words}.`);
          expect(value.classList.contains("warn")).toBe(mode === "allowlist" && list.length === 0);
        }
      ),
      { numRuns: 60 }
    );
  });

  test("renderScopeLoadError defaults to 'all' and shows the inline message (Req 13.3)", () => {
    renderScopeLoadError();
    const all = document.getElementById("scopeModeAll")!;
    const loadError = document.getElementById("scopeLoadError")!;

    expect(all.classList.contains("active")).toBe(true);
    expect(loadError.style.display).toBe("block");
    expect(document.getElementById("scopeListRowValue")!.textContent).toBe("All sites");
    expect(document.getElementById("scopeListContent")!.hidden).toBe(true);
  });

  test("mode change failure reverts the selection and shows 'not saved' (Req 13.5, 9.5)", async () => {
    renderScope(makeSettings({ scopeMode: "allowlist", allowlist: [] }));

    vi.mocked(browser.runtime.sendMessage).mockResolvedValue({ error: "STORAGE_ERROR" });

    document.getElementById("scopeModeDenylist")!.click();
    await flush();

    const allow = document.getElementById("scopeModeAllowlist")!;
    const deny = document.getElementById("scopeModeDenylist")!;
    const modeError = document.getElementById("scopeModeError")!;

    // Reverted back to the previously persisted mode.
    expect(allow.classList.contains("active")).toBe(true);
    expect(deny.classList.contains("active")).toBe(false);
    expect(modeError.style.display).toBe("block");
  });

  test("mode change success sends SET_SCOPE_MODE with the chosen mode (Req 13.4)", async () => {
    renderScope(makeSettings({ scopeMode: "all" }));

    vi.mocked(browser.runtime.sendMessage).mockImplementation((msg: unknown) => {
      const m = msg as { type: string };
      if (m.type === "SET_SCOPE_MODE") return Promise.resolve({ success: true });
      if (m.type === "GET_SETTINGS")
        return Promise.resolve(makeSettings({ scopeMode: "allowlist", allowlist: [] }));
      return Promise.resolve(undefined);
    });

    document.getElementById("scopeModeAllowlist")!.click();
    await flush();

    expect(browser.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "SET_SCOPE_MODE",
        payload: { scopeMode: "allowlist" },
      })
    );
  });
});

describe("Popup Filters tab — site list manager (Req 14)", () => {
  beforeEach(() => {
    loadPopupDom();
    vi.mocked(browser.tabs.query).mockResolvedValue([]);
  });

  test("shows the empty-list indicator when the active list is empty (Req 14.8)", () => {
    renderScope(makeSettings({ scopeMode: "allowlist", allowlist: [] }));
    const empty = document.getElementById("scopeEmptyIndicator")!;
    const list = document.getElementById("scopeList")!;
    expect(empty.style.display).toBe("block");
    expect(list.children.length).toBe(0);
  });

  test("renders one row per entry with a remove control, hiding the indicator (Req 14.1)", () => {
    renderScope(
      makeSettings({ scopeMode: "denylist", denylist: ["example.com", "ads.tracker.net"] })
    );
    const empty = document.getElementById("scopeEmptyIndicator")!;
    const list = document.getElementById("scopeList")!;

    expect(empty.style.display).toBe("none");
    expect(list.children.length).toBe(2);
    expect(list.querySelectorAll(".scope-site-remove").length).toBe(2);
    expect(list.querySelectorAll(".scope-site-domain")[0].textContent).toBe("example.com");
  });

  // Property: any invalid domain typed into the add field shows the inline
  // message and sends nothing; the typed input is retained (Req 14.4).
  test("invalid manual entries are rejected inline and never sent (Req 14.4)", () => {
    const invalidInputs = fc.oneof(
      fc.constant(""),
      fc.constant("nodot"),
      fc.constant("not a domain"),
      fc.constant("exa*mple.com"),
      fc.constant("-bad.com"),
      fc.constant("http://"),
      fc.constant("foo..bar")
    );

    fc.assert(
      fc.property(invalidInputs, (raw) => {
        // Precondition: the shared parser agrees this is invalid.
        fc.pre(parsePattern(raw) === null);

        loadPopupDom();
        renderScope(makeSettings({ scopeMode: "allowlist", allowlist: [] }));
        vi.mocked(browser.runtime.sendMessage).mockClear();

        const input = document.getElementById("scopeAddInput") as HTMLInputElement;
        const button = document.getElementById("scopeAddButton") as HTMLButtonElement;
        input.value = raw;
        button.click();

        const addError = document.getElementById("scopeAddError")!;
        expect(addError.style.display).toBe("block");
        expect(input.value).toBe(raw); // input retained
        const calls = vi.mocked(browser.runtime.sendMessage).mock.calls;
        const sentAdd = calls.some((c) => (c[0] as { type?: string })?.type === "ADD_SCOPE_SITE");
        expect(sentAdd).toBe(false);
      }),
      { numRuns: 30 }
    );
  });

  test("valid manual entry sends ADD_SCOPE_SITE with the canonical pattern (Req 14.2)", async () => {
    renderScope(makeSettings({ scopeMode: "allowlist", allowlist: [] }));

    vi.mocked(browser.runtime.sendMessage).mockImplementation((msg: unknown) => {
      const m = msg as { type: string };
      if (m.type === "ADD_SCOPE_SITE") return Promise.resolve({ success: true });
      if (m.type === "GET_SETTINGS")
        return Promise.resolve(
          makeSettings({ scopeMode: "allowlist", allowlist: ["https://www.example.com/path"] })
        );
      return Promise.resolve(undefined);
    });

    const input = document.getElementById("scopeAddInput") as HTMLInputElement;
    const button = document.getElementById("scopeAddButton") as HTMLButtonElement;
    // Scheme/host lowercased, path preserved, `www.` NOT stripped.
    input.value = "https://www.Example.com/path";
    button.click();
    await flush();

    expect(browser.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ADD_SCOPE_SITE",
        payload: { list: "allowlist", pattern: "https://www.example.com/path" },
      })
    );
  });

  test("a wildcard/port/path pattern is accepted and sent verbatim", async () => {
    renderScope(makeSettings({ scopeMode: "denylist", denylist: [] }));

    vi.mocked(browser.runtime.sendMessage).mockImplementation((msg: unknown) => {
      const m = msg as { type: string };
      if (m.type === "ADD_SCOPE_SITE") return Promise.resolve({ success: true });
      if (m.type === "GET_SETTINGS")
        return Promise.resolve(makeSettings({ scopeMode: "denylist", denylist: ["*.ru"] }));
      return Promise.resolve(undefined);
    });

    const input = document.getElementById("scopeAddInput") as HTMLInputElement;
    const button = document.getElementById("scopeAddButton") as HTMLButtonElement;
    input.value = "*.ru";
    button.click();
    await flush();

    // A wildcard TLD is no longer rejected by the popup (was under normalizeDomain).
    expect(document.getElementById("scopeAddError")!.style.display).not.toBe("block");
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ADD_SCOPE_SITE",
        payload: { list: "denylist", pattern: "*.ru" },
      })
    );
  });

  test("remove sends REMOVE_SCOPE_SITE and reflects success (Req 14.6)", async () => {
    renderScope(makeSettings({ scopeMode: "allowlist", allowlist: ["example.com"] }));

    vi.mocked(browser.runtime.sendMessage).mockImplementation((msg: unknown) => {
      const m = msg as { type: string };
      if (m.type === "REMOVE_SCOPE_SITE") return Promise.resolve({ success: true });
      if (m.type === "GET_SETTINGS")
        return Promise.resolve(makeSettings({ scopeMode: "allowlist", allowlist: [] }));
      return Promise.resolve(undefined);
    });

    const removeBtn = document.querySelector(".scope-site-remove") as HTMLButtonElement;
    removeBtn.click();
    await flush();

    expect(browser.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "REMOVE_SCOPE_SITE",
        payload: { list: "allowlist", pattern: "example.com" },
      })
    );
    // After the success-driven reload the list is empty.
    const list = document.getElementById("scopeList")!;
    expect(list.children.length).toBe(0);
  });

  test("remove failure restores the optimistically removed row (Req 14.6, 9.5)", async () => {
    renderScope(makeSettings({ scopeMode: "denylist", denylist: ["example.com"] }));
    document.getElementById("scopeListRow")!.click();

    vi.mocked(browser.runtime.sendMessage).mockResolvedValue({ error: "STORAGE_ERROR" });

    const removeBtn = document.querySelector(".scope-site-remove") as HTMLButtonElement;
    removeBtn.click();
    await flush();

    const list = document.getElementById("scopeList")!;
    const error = document.getElementById("scopeAddError")!;
    // Row restored after the failed removal.
    expect(list.children.length).toBe(1);
    expect(list.querySelector(".scope-site-domain")!.textContent).toBe("example.com");
    // The message shows on the list screen, not on the hidden root.
    expect(document.getElementById("scopeListScreen")!.hidden).toBe(false);
    expect(error.style.display).toBe("block");
    expect(error.closest("[hidden]")).toBeNull();
  });
});

describe("Popup Filters tab — '＋ Add <site>' on the list screen", () => {
  beforeEach(() => {
    __resetScopeForTest();
    loadPopupDom();
    vi.mocked(browser.tabs.query).mockResolvedValue([]);
    vi.mocked(browser.runtime.sendMessage).mockReset();
  });

  function addSiteButton(): HTMLButtonElement {
    return document.getElementById("scopeAddSiteButton") as HTMLButtonElement;
  }

  function sentAdds(): unknown[] {
    return vi
      .mocked(browser.runtime.sendMessage)
      .mock.calls.map((c) => c[0] as { type?: string; payload?: unknown })
      .filter((m) => m.type === "ADD_SCOPE_SITE")
      .map((m) => m.payload);
  }

  test.each([
    ["a restricted page", "chrome://settings/"],
    ["the extension's own page (the options tab)", "moz-extension://test/popup/popup.html"],
    ["a host that isn't a site", "http://intranet/"],
    ["no tab", undefined],
  ])("hidden on %s, with no status line either", (_name, url) => {
    // A single-label host other than localhost has no dot → parsePattern is null.
    expect(parsePattern("intranet")).toBeNull();
    renderScope(makeSettings({ scopeMode: "allowlist", allowlist: [] }), false, url);
    expect(addSiteButton().hidden).toBe(true);
    expect(document.getElementById("scopeSiteStatus")!.hidden).toBe(true);
    addSiteButton().click();
    expect(sentAdds()).toEqual([]);
  });

  test("on https://www.twitch.tv/ it offers and adds twitch.tv, then says it's listed", async () => {
    const url = "https://www.twitch.tv/somechannel";
    renderScope(makeSettings({ scopeMode: "allowlist", allowlist: [] }), false, url);
    expect(addSiteButton().hidden).toBe(false);
    expect(document.getElementById("scopeAddSiteLabel")!.textContent).toBe("Add twitch.tv");
    expect(addSiteButton().querySelector("[aria-hidden='true']")?.textContent).toBe("＋");

    vi.mocked(browser.tabs.query).mockResolvedValue([{ url, id: 3 }] as unknown as never);
    vi.mocked(browser.runtime.sendMessage).mockImplementation((msg: unknown) => {
      const m = msg as { type: string };
      if (m.type === "ADD_SCOPE_SITE") return Promise.resolve({ success: true });
      if (m.type === "GET_SETTINGS")
        return Promise.resolve(makeSettings({ scopeMode: "allowlist", allowlist: ["twitch.tv"] }));
      return Promise.resolve(undefined);
    });
    // Visible, so the status line can take focus.
    document.getElementById("filtersView")!.style.display = "block";
    document.getElementById("filtersRoot")!.hidden = true;
    document.getElementById("scopeListScreen")!.hidden = false;
    addSiteButton().click();
    await flush();
    await flush();

    expect(sentAdds()).toEqual([{ list: "allowlist", pattern: "twitch.tv" }]);
    expect(addSiteButton().hidden).toBe(true);
    const status = document.getElementById("scopeSiteStatus")!;
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe("✓ twitch.tv · Listed");
    expect(status.querySelector("[aria-hidden='true']")?.textContent).toBe("✓ ");
    expect(document.activeElement).toBe(status);
  });

  // Property: for any host, with or without www., the button adds the host
  // without one www., exactly as it names it.
  test("it adds exactly the site it names", async () => {
    const label = fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/);
    await fc.assert(
      fc.asyncProperty(label, label, fc.boolean(), async (name, tld, www) => {
        fc.pre(name !== "www" && tld.length >= 2);
        __resetScopeForTest();
        loadPopupDom();
        vi.mocked(browser.runtime.sendMessage).mockReset();
        // Held, so the reload never replaces what's checked.
        vi.mocked(browser.runtime.sendMessage).mockReturnValue(new Promise(() => {}));
        const site = `${name}.${tld}`;
        renderScope(
          makeSettings({ scopeMode: "denylist", denylist: [] }),
          false,
          `https://${www ? "www." : ""}${site}/path`
        );
        expect(document.getElementById("scopeAddSiteLabel")!.textContent).toBe(`Add ${site}`);
        addSiteButton().click();
        await Promise.resolve();
        expect(sentAdds()).toEqual([{ list: "denylist", pattern: site }]);
      }),
      { numRuns: 50 }
    );
  });

  test("a site the list covers says which entry covers it", () => {
    renderScope(
      makeSettings({ scopeMode: "denylist", denylist: ["*.tv"] }),
      false,
      "https://www.twitch.tv/"
    );
    expect(addSiteButton().hidden).toBe(true);
    expect(document.getElementById("scopeSiteStatus")!.textContent).toBe(
      "✓ twitch.tv · Covered by *.tv"
    );
  });

  test("a failed add says the change wasn't saved and keeps the button", async () => {
    renderScope(
      makeSettings({ scopeMode: "allowlist", allowlist: [] }),
      false,
      "https://example.com/"
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(browser.runtime.sendMessage).mockResolvedValue({ error: "STORAGE_ERROR" });
    addSiteButton().click();
    await flush();
    expect(sentAdds()).toEqual([{ list: "allowlist", pattern: "example.com" }]);
    expect(document.getElementById("scopeAddError")!.style.display).toBe("block");
    expect(document.getElementById("scopeAddError")!.textContent).toBe("⚠ Change not saved");
    expect(addSiteButton().hidden).toBe(false);
    spy.mockRestore();
  });
});

describe("Popup Filters tab — the root and the list screen (design H)", () => {
  beforeEach(() => {
    __resetScopeForTest();
    loadPopupDom();
    document.getElementById("mainView")!.style.display = "none";
    document.getElementById("filtersView")!.style.display = "block";
    vi.mocked(browser.tabs.query).mockResolvedValue([]);
    vi.mocked(browser.runtime.sendMessage).mockReset();
  });

  function byId(id: string): HTMLElement {
    return document.getElementById(id)!;
  }

  test.each([
    ["all", "GeoSpoof works on every site."],
    ["allowlist", "GeoSpoof works only on sites in the Allowlist."],
    ["denylist", "GeoSpoof works on every site except those in the Denylist."],
  ] as const)("in %s mode the sentence says what it does", (mode, sentence) => {
    renderScope(makeSettings({ scopeMode: mode }));
    expect(byId("scopeModeDesc").textContent).toBe(sentence);
    expect(byId("scopeModeDesc").hidden).toBe(false);
    expect(byId("scopeProNote").hidden).toBe(true);
    expect(byId("scopeModeAll").textContent?.trim()).toBe("All sites");
  });

  test("the Pro lock disables the segments, and the Pro note replaces the sentence (H-8)", () => {
    renderScope(makeSettings({ scopeMode: "allowlist", allowlist: ["a.com"] }), true);
    document.querySelectorAll<HTMLButtonElement>(".scope-mode-btn").forEach((btn) => {
      expect(btn.disabled).toBe(true);
    });
    expect(byId("scopeModeAll").getAttribute("aria-checked")).toBe("true");
    expect(byId("scopeModeDesc").hidden).toBe(true);
    expect(byId("scopeProNote").hidden).toBe(false);
    expect(byId("scopeProNote").textContent?.replace(/\s+/g, " ").trim()).toBe(
      "🔒 Allowlist, Denylist and per-site locations are GeoSpoof Pro features. Upgrade in the GeoSpoof app."
    );
    // The row still opens the Filters screen, which shows the lock and no list.
    expect(byId("scopeListRowValue").textContent).toBe("All sites");
    expect(byId("scopeListContent").hidden).toBe(true);

    renderScope(makeSettings({ scopeMode: "allowlist", allowlist: ["a.com"] }), false);
    expect(byId("scopeModeDesc").hidden).toBe(false);
    expect(byId("scopeProNote").hidden).toBe(true);
  });

  test("the Filters row opens its screen: title, mode, list, focus on the title; back returns", () => {
    renderScope(makeSettings({ scopeMode: "denylist", denylist: ["a.com", "*.ru"] }));
    const row = byId("scopeListRow");
    expect(row.textContent?.replace(/\s+/g, " ").trim()).toBe("Filters Denylist · 2 ›");
    expect(byId("scopeListRowDesc").textContent).toBe("Denylist: 2 on the list.");
    row.focus();
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(byId("scopeListScreen").hidden).toBe(false);
    expect(byId("filtersRoot").hidden).toBe(true);
    expect(byId("scopeListTitle").textContent?.trim()).toBe("Filters");
    // The mode control is on this screen, before the list.
    expect(byId("scopeListScreen").contains(byId("scopeModeTabs"))).toBe(true);
    expect(byId("scopeModeTabs").compareDocumentPosition(byId("scopeListContent"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(document.activeElement).toBe(byId("scopeListTitle"));
    // The list keeps its name: the list's own.
    expect(byId("scopeList").getAttribute("aria-labelledby")).toBe("scopeListName");
    expect(byId("scopeListName").textContent).toBe("Denylist");

    byId("scopeListTitle").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
    );
    expect(byId("filtersRoot").hidden).toBe(false);
    expect(document.activeElement).toBe(row);
  });

  test("an empty Allowlist warns on the Filters row", () => {
    renderScope(makeSettings({ scopeMode: "allowlist", allowlist: [] }));
    expect(document.getElementById("scopeListCaption")).toBeNull();
    expect(byId("scopeListRowValue").textContent).toBe("⚠ Empty · Off on every site");
    expect(byId("scopeListRowValue").querySelector("[aria-hidden='true']")?.textContent).toBe("⚠ ");
  });

  test("a mode change moves the segments and the sentence at once, the row only once saved", async () => {
    renderScope(makeSettings({ scopeMode: "all" }));
    let reply: (value: unknown) => void = () => {};
    vi.mocked(browser.runtime.sendMessage).mockImplementation(
      () => new Promise((resolve) => (reply = resolve))
    );
    byId("scopeModeAllowlist").click();
    expect(byId("scopeModeAllowlist").getAttribute("aria-checked")).toBe("true");
    expect(byId("scopeModeDesc").textContent).toBe(
      "GeoSpoof works only on sites in the Allowlist."
    );
    expect(byId("scopeListContent").hidden).toBe(true);

    // The save fails: the selection and the sentence go back, the row never showed.
    reply({ error: "STORAGE_ERROR" });
    await flush();
    expect(byId("scopeModeAll").getAttribute("aria-checked")).toBe("true");
    expect(byId("scopeModeDesc").textContent).toBe("GeoSpoof works on every site.");
    expect(byId("scopeListContent").hidden).toBe(true);
    expect(byId("scopeListRowValue").textContent).toBe("All sites");
    expect(byId("scopeModeError").style.display).toBe("block");
  });

  test("switching to All sites keeps the Filters screen open and hides its list", () => {
    renderScope(makeSettings({ scopeMode: "allowlist", allowlist: [] }));
    byId("scopeListRow").click();
    expect(byId("scopeListScreen").hidden).toBe(false);
    renderScope(makeSettings({ scopeMode: "all" }));
    expect(byId("scopeListScreen").hidden).toBe(false);
    expect(byId("scopeListContent").hidden).toBe(true);
    expect(byId("filtersRoot").hidden).toBe(true);
  });
});
