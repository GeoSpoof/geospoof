/**
 * Property + unit tests for the popup Filters tab (site-scoping UI).
 *
 * Mirrors the structure of popup-validation.property.test.ts. Covers:
 *   - inline parse validation on manual add (Req 12.3, 14.2, 14.4)
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
import { renderScope, renderScopeLoadError } from "@/popup/scope";
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

  test("hides the list manager in 'all' mode (Req 13.8)", () => {
    renderScope(makeSettings({ scopeMode: "all" }));
    const manager = document.getElementById("scopeListManager")!;
    expect(manager.style.display).toBe("none");
  });

  test("shows the list manager in list modes (Req 13.6, 13.7)", () => {
    renderScope(makeSettings({ scopeMode: "allowlist", allowlist: [] }));
    const manager = document.getElementById("scopeListManager")!;
    expect(manager.style.display).toBe("block");
  });

  test("renderScopeLoadError defaults to 'all' and shows the inline message (Req 13.3)", () => {
    renderScopeLoadError();
    const all = document.getElementById("scopeModeAll")!;
    const loadError = document.getElementById("scopeLoadError")!;
    const manager = document.getElementById("scopeListManager")!;

    expect(all.classList.contains("active")).toBe(true);
    expect(loadError.style.display).toBe("block");
    expect(manager.style.display).toBe("none");
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

    vi.mocked(browser.runtime.sendMessage).mockResolvedValue({ error: "STORAGE_ERROR" });

    const removeBtn = document.querySelector(".scope-site-remove") as HTMLButtonElement;
    removeBtn.click();
    await flush();

    const list = document.getElementById("scopeList")!;
    const modeError = document.getElementById("scopeModeError")!;
    // Row restored after the failed removal.
    expect(list.children.length).toBe(1);
    expect(list.querySelector(".scope-site-domain")!.textContent).toBe("example.com");
    expect(modeError.style.display).toBe("block");
  });
});

describe("Popup Filters tab — add current site (Req 14.3, 14.7, 14.9)", () => {
  beforeEach(() => {
    loadPopupDom();
    vi.mocked(browser.tabs.query).mockResolvedValue([]);
    vi.mocked(browser.runtime.sendMessage).mockReset();
  });

  test("restricted current URL shows an inline message and sends nothing (Req 14.7)", async () => {
    renderScope(makeSettings({ scopeMode: "allowlist", allowlist: [] }));

    // Active tab is a restricted page (chrome:// is in isRestrictedUrl's prefixes).
    vi.mocked(browser.tabs.query).mockResolvedValue([
      { url: "chrome://settings/", id: 1 },
    ] as unknown as never);

    const currentBtn = document.getElementById("scopeAddCurrentButton") as HTMLButtonElement;
    currentBtn.click();
    await flush();

    const msg = document.getElementById("scopeCurrentMsg")!;
    expect(msg.style.display).toBe("block");

    const sentAdd = vi
      .mocked(browser.runtime.sendMessage)
      .mock.calls.some((c) => (c[0] as { type?: string })?.type === "ADD_SCOPE_SITE");
    expect(sentAdd).toBe(false);
  });

  test("non-restricted URL with an un-normalizable hostname shows a message and sends nothing (Req 14.9)", async () => {
    renderScope(makeSettings({ scopeMode: "allowlist", allowlist: [] }));

    // A single-label host other than localhost has no dot → parsePattern is null.
    // (localhost itself is now a valid pattern, so it is intentionally not used here.)
    expect(parsePattern("intranet")).toBeNull();
    vi.mocked(browser.tabs.query).mockResolvedValue([
      { url: "http://intranet/", id: 2 },
    ] as unknown as never);

    const currentBtn = document.getElementById("scopeAddCurrentButton") as HTMLButtonElement;
    currentBtn.click();
    await flush();

    const msg = document.getElementById("scopeCurrentMsg")!;
    expect(msg.style.display).toBe("block");

    const sentAdd = vi
      .mocked(browser.runtime.sendMessage)
      .mock.calls.some((c) => (c[0] as { type?: string })?.type === "ADD_SCOPE_SITE");
    expect(sentAdd).toBe(false);
  });

  test("valid current URL sends ADD_SCOPE_SITE with the host pattern (Req 14.3)", async () => {
    renderScope(makeSettings({ scopeMode: "denylist", denylist: [] }));

    vi.mocked(browser.tabs.query).mockResolvedValue([
      { url: "https://www.Example.com:8443/some/path?q=1#h", id: 3 },
    ] as unknown as never);

    vi.mocked(browser.runtime.sendMessage).mockImplementation((msg: unknown) => {
      const m = msg as { type: string };
      if (m.type === "ADD_SCOPE_SITE") return Promise.resolve({ success: true });
      if (m.type === "GET_SETTINGS")
        return Promise.resolve(
          makeSettings({ scopeMode: "denylist", denylist: ["www.example.com"] })
        );
      return Promise.resolve(undefined);
    });

    const currentBtn = document.getElementById("scopeAddCurrentButton") as HTMLButtonElement;
    currentBtn.click();
    await flush();

    // Add-current uses the tab's host as a bare-host pattern (port/path excluded);
    // `www.` is not stripped.
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "ADD_SCOPE_SITE",
        payload: { list: "denylist", pattern: "www.example.com" },
      })
    );

    // No inline error is surfaced on the success path.
    const msg = document.getElementById("scopeCurrentMsg")!;
    expect(msg.style.display).toBe("none");
  });
});
