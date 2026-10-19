/**
 * Site locations: all consumers agree.
 *
 * A missed consumer is the likeliest bug for any per-tab feature (duplicated
 * builders once leaked the raw precision anchor). For a matched, an unmatched,
 * and an out-of-scope URL, every page builder must deliver the same payload,
 * and every other consumer (Accept-Language value and DNR plan, worker payload,
 * CDP overrides, toolbar title) must derive from that payload's zone and place.
 *
 * Vitest compiles `__CHROMIUM__` and `__SAFARI__` to false, so the DNR and CDP
 * paths are checked through their pure planners.
 */

import { describe, test, expect, vi } from "vitest";
import type { Settings } from "@/shared/types/settings";
import { DEFAULT_SETTINGS } from "@/shared/types/settings";
import type { Message, UpdateSettingsPayload } from "@/shared/types/messages";
import { resolveLocale, resolvePageLocale } from "@/shared/locale/resolver";
import { resolveSiteSettings } from "@/shared/utils/site-locations";
import { mocks } from "../../helpers/cadence";
import { scriptMatchesUrl } from "../../helpers/match-pattern";
import {
  ENTRY_DUBLIN,
  ENTRY_MEXICO_CITY,
  TOKYO,
  TOKYO_NAME,
  TOKYO_TZ,
} from "../../helpers/site-locations";

const SETTINGS: Settings = {
  ...DEFAULT_SETTINGS,
  enabled: true,
  onboardingCompleted: true,
  location: TOKYO,
  timezone: TOKYO_TZ,
  locationName: TOKYO_NAME,
  // openai.com belongs to the Dublin entry but is NOT allowlisted, so it's the
  // matched-but-out-of-scope row.
  scopeMode: "allowlist",
  allowlist: ["chatgpt.com", "twitch.tv", "example.org"],
  localeSpoofing: { mode: "match" },
  locationPrecision: { mode: "approximate", radiusMeters: 2000 },
  accuracySeed: 777,
  precisionSeed: 123456789,
  siteLocations: [ENTRY_DUBLIN, ENTRY_MEXICO_CITY],
};

interface Row {
  label: string;
  url: string;
  tabId: number;
  enabled: boolean;
  zone: string;
  place: string | null;
  /** The anchor the reported (approximate, 2 km) point is drawn around. */
  anchor: { latitude: number; longitude: number };
}

const ROWS: Row[] = [
  {
    label: "matched (Dublin)",
    url: "https://chatgpt.com/",
    tabId: 11,
    enabled: true,
    zone: "Europe/Dublin",
    place: "Dublin",
    anchor: ENTRY_DUBLIN.location,
  },
  {
    label: "matched via www (Mexico City)",
    url: "https://www.twitch.tv/x",
    tabId: 12,
    enabled: true,
    zone: "America/Mexico_City",
    place: "Mexico City",
    anchor: ENTRY_MEXICO_CITY.location,
  },
  {
    label: "unmatched (main location)",
    url: "https://example.org/",
    tabId: 13,
    enabled: true,
    zone: "Asia/Tokyo",
    place: null,
    anchor: TOKYO,
  },
  {
    label: "out of scope (allowlist excludes it)",
    url: "https://openai.com/",
    tabId: 14,
    enabled: false,
    zone: "Asia/Tokyo",
    place: null,
    anchor: TOKYO,
  },
];

async function importBackgroundWith(s: Settings) {
  vi.clearAllMocks();
  vi.resetModules();
  browser.storage.local.get = vi.fn().mockResolvedValue({ settings: s });
  browser.storage.local.set = vi.fn().mockResolvedValue(undefined);
  return import("@/background");
}

/** Collect the payload each page builder delivers for `url`. */
async function collectPayloads(url: string): Promise<UpdateSettingsPayload[]> {
  const bg = await importBackgroundWith(SETTINGS);
  const { buildPagePayload } = await import("@/background/page-payload");
  const payloads: UpdateSettingsPayload[] = [];

  const sent: Array<{ tabId: number; payload: UpdateSettingsPayload }> = [];
  browser.tabs.sendMessage = vi
    .fn()
    .mockImplementation((tabId: number, message: Message<UpdateSettingsPayload>) => {
      if (message.type === "UPDATE_SETTINGS" && message.payload) {
        sent.push({ tabId, payload: message.payload });
      }
      return Promise.resolve();
    });

  // 0. The module itself.
  payloads.push(await buildPagePayload(SETTINGS, url));

  // 1. sendSettingsToTab, via the broadcast.
  browser.tabs.query = vi.fn().mockResolvedValue([{ id: 1, url }]);
  await bg.broadcastSettingsToTabs(SETTINGS);
  payloads.push(sent.find((m) => m.tabId === 1)!.payload);

  // 2. Content-script GET_SETTINGS.
  payloads.push(
    (await bg.handleMessage(
      { type: "GET_SETTINGS" },
      { tab: { id: 2, url } as browser.tabs.Tab }
    )) as UpdateSettingsPayload
  );

  // 3. tabs.onCreated, sent after its 100ms delay.
  const onCreated = mocks.onCreatedAddListener().mock.calls.at(-1)?.[0] as
    ((tab: { id?: number; url?: string }) => void) | undefined;
  expect(onCreated, "tabs.onCreated listener was not registered").toBeDefined();
  vi.useFakeTimers();
  try {
    onCreated!({ id: 42, url });
    await vi.waitFor(() => expect(sent.some((m) => m.tabId === 42)).toBe(true), {
      timeout: 2000,
    });
  } finally {
    vi.useRealTimers();
  }
  payloads.push(sent.find((m) => m.tabId === 42)!.payload);

  // 4. The injection-check alarm builder (PING resolves → injected).
  browser.tabs.get = vi.fn().mockResolvedValue({ id: 7, url });
  await bg.onAlarm({ name: "injection-check:7:0", scheduledTime: Date.now() });
  payloads.push(sent.find((m) => m.tabId === 7)!.payload);

  return payloads;
}

describe("Site locations: all consumers agree", () => {
  test.each(ROWS)("$label: the five page builders deliver one payload", async (row) => {
    const payloads = await collectPayloads(row.url);
    expect(payloads).toHaveLength(5);
    const [first, ...rest] = payloads.map((p) => JSON.stringify(p));
    for (const other of rest) expect(other).toBe(first);

    const payload = payloads[0];
    expect(payload.enabled).toBe(row.enabled);
    expect(payload.timezone?.identifier).toBe(row.zone);
    expect(payload.locale).toEqual(resolvePageLocale({ mode: "match" }, row.zone));
    // Within the 2 km radius of the row's anchor (0.05° is ~5 km): precision
    // applies to a site location's point with the global seed and cadence.
    expect(Math.abs(payload.location!.latitude - row.anchor.latitude)).toBeLessThan(0.05);
    expect(Math.abs(payload.location!.longitude - row.anchor.longitude)).toBeLessThan(0.05);
    expect(payload.location).not.toEqual(row.anchor);
    expect(payload).not.toHaveProperty("siteLocations");
  });

  test.each(ROWS)("$label: every other consumer derives from the payload", async (row) => {
    const [payload] = await collectPayloads(row.url);
    const zone = payload.timezone!.identifier;
    const { resolveAcceptLanguageFor, planAcceptLanguageRules } =
      await import("@/background/accept-language");
    const { workerPayloadFor } = await import("@/background/worker-request-filter");
    const { buildOverridesForTab } = await import("@/background/debugger-spoof");
    const { tabTitleFor } = await import("@/background/badge");
    const { isRestrictedUrl } = await import("@/background/restricted-url");

    // Accept-Language: the value, and the DNR group holding this tab.
    const header = resolveAcceptLanguageFor(SETTINGS, row.url);
    const plan = planAcceptLanguageRules(
      SETTINGS,
      ROWS.map((r) => ({ id: r.tabId, url: r.url }))
    );
    const group = plan.find(
      (rule) => "tabIds" in rule.condition && rule.condition.tabIds.includes(row.tabId)
    );
    if (payload.enabled) {
      const expected = resolveLocale({ mode: "match" }, zone)!.acceptLanguage;
      expect(header).toBe(expected);
      expect(group?.value).toBe(expected);
    } else {
      expect(header).toBeNull();
      expect(group).toBeUndefined();
    }

    // Worker payload embeds the same zone.
    expect(workerPayloadFor(SETTINGS, row.url)).toContain(JSON.stringify(zone));

    // CDP overrides (debugger mode on) apply the same zone, or none out of scope.
    const overrides = buildOverridesForTab({ ...SETTINGS, debuggerModeEnabled: true }, row.url);
    expect(overrides?.timezoneId ?? null).toBe(payload.enabled ? zone : null);

    // The toolbar title names the matched place.
    const title = tabTitleFor(resolveSiteSettings(SETTINGS, row.url, isRestrictedUrl), row.url);
    if (row.place !== null) {
      expect(title).toBe(`GeoSpoof: ${row.place} on ${new URL(row.url).hostname}`);
    } else {
      expect(title).toBe("GeoSpoof");
    }
  });

  // The Firefox bootstrap script matching each row's top frame (if any) inlines
  // the same `timezone`, `location`, and `locale` as the payload above, and no
  // bootstrap script matches the out-of-scope row.
  describe("Firefox bootstrap agrees with the page payload", () => {
    test.each(ROWS)("$label", async (row) => {
      const [payload] = await collectPayloads(row.url);
      const { planBootstrapScripts } = await import("@/background/bootstrap-register");
      const { buildBootstrapPayload } = await import("@/background/page-payload");

      const hits = planBootstrapScripts(SETTINGS).filter((item) => scriptMatchesUrl(item, row.url));
      expect(hits.length).toBeLessThanOrEqual(1);
      if (!payload.enabled) {
        expect(hits).toEqual([]);
        return;
      }
      // Every in-scope row here has a seedable pattern, so it gets a script.
      expect(hits).toHaveLength(1);
      const boot = await buildBootstrapPayload(hits[0].settings);
      expect(boot.timezone).toEqual(payload.timezone);
      expect(boot.location).toEqual(payload.location);
      expect(boot.locale).toEqual(payload.locale);
      expect(hits[0].settings.locationName?.city ?? null).toBe(row.place ?? "Tokyo");
    });
  });
});
