/**
 * The "Protection enabled but no location set" warning with Per-site locations
 * (GeoSpoof/geospoof#177). A site location still spoofs its own site without a
 * main location, so the warning is hidden only on a tab one applies to; on
 * every other tab nothing is spoofed, so it shows as it did before #177.
 *
 * Runs the real loadSettings against the full assets/popup.html.
 */

import fs from "fs";
import path from "path";
import type { Settings } from "@/shared/types/settings";
import { DEFAULT_SETTINGS } from "@/shared/types/settings";
import { loadSettings } from "@/popup/settings";
import { __resetSiteLocationsForTest } from "@/popup/site-locations";
import { ENTRY_MEXICO_CITY, TOKYO, TOKYO_NAME, TOKYO_TZ } from "../../helpers/site-locations";

const HTML = fs.readFileSync(path.join(__dirname, "../../../assets/popup.html"), "utf8");

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    enabled: true,
    onboardingCompleted: true,
    location: null,
    timezone: null,
    locationName: null,
    siteLocations: [ENTRY_MEXICO_CITY],
    ...overrides,
  };
}

async function warningOn(url: string, settings: Settings): Promise<string> {
  vi.mocked(browser.tabs.query).mockResolvedValue([{ id: 1, url } as browser.tabs.Tab]);
  vi.mocked(browser.runtime.sendMessage).mockImplementation((message: unknown) => {
    const { type } = message as { type: string };
    if (type === "GET_SETTINGS") return Promise.resolve(settings);
    if (type === "CHECK_TAB_INJECTION") return Promise.resolve({ injected: true, error: null });
    return Promise.resolve(undefined);
  });
  await loadSettings();
  return document.getElementById("warningMessage")!.style.display;
}

describe("No-main-location warning with Per-site locations", () => {
  beforeEach(() => {
    document.documentElement.innerHTML = HTML;
    __resetSiteLocationsForTest();
  });

  afterEach(() => {
    vi.mocked(browser.tabs.query).mockReset().mockResolvedValue([]);
    vi.mocked(browser.runtime.sendMessage).mockReset();
  });

  test("shows on a tab no site location applies to", async () => {
    expect(await warningOn("https://example.org/", makeSettings())).toBe("block");
    expect(document.getElementById("warningMessage")!.textContent).toBe(
      "⚠️ Protection enabled but no location set"
    );
  });

  test("hides on a tab a site location applies to", async () => {
    expect(await warningOn("https://twitch.tv/", makeSettings())).toBe("none");
    expect(document.getElementById("siteLocationLine")!.hidden).toBe(false);
  });

  test("shows where Filters keep the site location from applying", async () => {
    const settings = makeSettings({ scopeMode: "allowlist", allowlist: ["example.com"] });
    expect(await warningOn("https://twitch.tv/", settings)).toBe("block");
  });

  test("hides with a main location set", async () => {
    const settings = makeSettings({
      location: TOKYO,
      timezone: TOKYO_TZ,
      locationName: TOKYO_NAME,
    });
    expect(await warningOn("https://example.org/", settings)).toBe("none");
  });

  test("hides with protection off", async () => {
    expect(await warningOn("https://example.org/", makeSettings({ enabled: false }))).toBe("none");
  });
});
