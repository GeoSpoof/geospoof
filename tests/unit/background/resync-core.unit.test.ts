/**
 * Unit tests for the shared VPN re-sync gate (resync-core).
 * Feature: vpn-region-sync
 *
 * The gate is the single funnel for every "the network might have changed"
 * trigger (proxy.settings.onChange, tab navigation, idle→active). It debounces
 * bursts, enforces a steady-state minimum-interval floor, runs one cheap IP
 * check, applies a switch-gap stability guard, and only geolocates + re-applies
 * the location when the exit IP genuinely moved. These tests drive
 * `triggerResyncCheck` directly with the vpn-sync / messages / settings
 * dependencies mocked.
 */

import { DEFAULT_SETTINGS } from "@/shared/types/settings";

// --- Mock the gate's direct dependencies ------------------------------------

const detectPublicIp = vi.fn<() => Promise<string>>();
const getLastSyncedIp = vi.fn<() => Promise<string | undefined>>();
const syncVpnLocation = vi.fn<(force: boolean) => Promise<unknown>>();
const clearEndpointCooldowns = vi.fn<() => void>();
vi.mock("@/background/vpn-sync", () => ({
  detectPublicIp: (): Promise<string> => detectPublicIp(),
  getLastSyncedIp: (): Promise<string | undefined> => getLastSyncedIp(),
  syncVpnLocation: (force: boolean): Promise<unknown> => syncVpnLocation(force),
  clearEndpointCooldowns: (): void => clearEndpointCooldowns(),
}));

// Resolves true: the write happened (VPN sync was still on when it ran).
const handleSetLocation = vi.fn<(...args: unknown[]) => Promise<boolean>>().mockResolvedValue(true);
vi.mock("@/background/messages", () => ({
  handleSetLocation: (...args: unknown[]): Promise<boolean> => handleSetLocation(...args),
}));

const loadSettings = vi.fn<() => Promise<unknown>>();
vi.mock("@/background/settings", () => ({
  loadSettings: (): Promise<unknown> => loadSettings(),
}));

async function freshCore() {
  vi.resetModules();
  const mod = await import("@/background/resync-core");
  mod._resetResyncCoreState();
  return mod;
}

beforeEach(() => {
  vi.useFakeTimers();
  detectPublicIp.mockReset();
  getLastSyncedIp.mockReset();
  syncVpnLocation.mockReset();
  handleSetLocation.mockClear();
  loadSettings.mockReset();
  loadSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, vpnSyncEnabled: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("triggerResyncCheck — decision logic", () => {
  test("does NOT re-sync when the exit IP is unchanged", async () => {
    detectPublicIp.mockResolvedValue("203.0.113.10");
    getLastSyncedIp.mockResolvedValue("203.0.113.10");

    const { triggerResyncCheck, RESYNC_DEBOUNCE_MS } = await freshCore();
    triggerResyncCheck("test");
    await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS);

    expect(detectPublicIp).toHaveBeenCalledTimes(1);
    expect(syncVpnLocation).not.toHaveBeenCalled();
    expect(handleSetLocation).not.toHaveBeenCalled();
  });

  test("re-syncs and applies the new location when a changed IP holds steady", async () => {
    // Changed vs last, and stable across the settle re-check.
    detectPublicIp.mockResolvedValue("198.51.100.7");
    getLastSyncedIp.mockResolvedValue("203.0.113.10");
    syncVpnLocation.mockResolvedValue({
      latitude: -33.8688,
      longitude: 151.2093,
      city: "Sydney",
      country: "Australia",
      ip: "198.51.100.7",
    });

    const { triggerResyncCheck, RESYNC_DEBOUNCE_MS, SWITCH_SETTLE_MS } = await freshCore();
    triggerResyncCheck("test");
    await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(SWITCH_SETTLE_MS);

    expect(detectPublicIp).toHaveBeenCalledTimes(2); // initial + settle confirmation
    expect(syncVpnLocation).toHaveBeenCalledWith(true);
    expect(handleSetLocation).toHaveBeenCalledTimes(1);
    const [coords, options] = handleSetLocation.mock.calls[0] as [
      { latitude: number; longitude: number },
      { fromVpnSync: boolean; onlyWhileVpnSync: boolean; locationName: { displayName: string } },
    ];
    expect(coords).toEqual({ latitude: -33.8688, longitude: 151.2093 });
    expect(options.fromVpnSync).toBe(true);
    // The write re-checks vpnSyncEnabled, so a manual change during the check is kept.
    expect(options.onlyWhileVpnSync).toBe(true);
    expect(options.locationName.displayName).toBe("Sydney, Australia");
  });

  test("switch-gap guard: does NOT re-sync when the new IP is still settling", async () => {
    // A transient (e.g. real ISP) IP on the first sample, a different IP on the
    // confirmation sample → not yet settled → defer, don't apply.
    detectPublicIp.mockResolvedValueOnce("108.21.168.116").mockResolvedValueOnce("198.51.100.7");
    getLastSyncedIp.mockResolvedValue("203.0.113.10");

    const { triggerResyncCheck, RESYNC_DEBOUNCE_MS, SWITCH_SETTLE_MS } = await freshCore();
    triggerResyncCheck("test");
    await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(SWITCH_SETTLE_MS);

    expect(detectPublicIp).toHaveBeenCalledTimes(2);
    expect(syncVpnLocation).not.toHaveBeenCalled();
    expect(handleSetLocation).not.toHaveBeenCalled();
  });

  test("ignores triggers when VPN sync mode is disabled", async () => {
    loadSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, vpnSyncEnabled: false });

    const { triggerResyncCheck, RESYNC_DEBOUNCE_MS } = await freshCore();
    triggerResyncCheck("test");
    await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS);

    expect(detectPublicIp).not.toHaveBeenCalled();
    expect(syncVpnLocation).not.toHaveBeenCalled();
  });

  test("coalesces a burst of triggers into a single IP check", async () => {
    detectPublicIp.mockResolvedValue("203.0.113.10");
    getLastSyncedIp.mockResolvedValue("203.0.113.10");

    const { triggerResyncCheck, RESYNC_DEBOUNCE_MS } = await freshCore();
    triggerResyncCheck("a");
    await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS / 2);
    triggerResyncCheck("b");
    await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS / 2);
    triggerResyncCheck("c");
    await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS);

    expect(detectPublicIp).toHaveBeenCalledTimes(1);
  });

  test("does not re-sync when IP detection fails mid-switch", async () => {
    detectPublicIp.mockRejectedValue(
      Object.assign(new Error("timed out"), { code: "IP_DETECTION_FAILED" })
    );

    const { triggerResyncCheck, RESYNC_DEBOUNCE_MS } = await freshCore();
    triggerResyncCheck("test");
    await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS);

    expect(syncVpnLocation).not.toHaveBeenCalled();
    expect(handleSetLocation).not.toHaveBeenCalled();
  });

  test("enforces the minimum interval between consecutive checks", async () => {
    detectPublicIp.mockResolvedValue("203.0.113.10");
    getLastSyncedIp.mockResolvedValue("203.0.113.10");

    const { triggerResyncCheck, RESYNC_DEBOUNCE_MS, MIN_CHECK_INTERVAL_MS } = await freshCore();

    triggerResyncCheck("first");
    await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS);
    expect(detectPublicIp).toHaveBeenCalledTimes(1);

    // Second trigger before the floor elapses → suppressed
    triggerResyncCheck("second");
    await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS);
    expect(detectPublicIp).toHaveBeenCalledTimes(1);

    // After the floor elapses, a further trigger is allowed through
    await vi.advanceTimersByTimeAsync(MIN_CHECK_INTERVAL_MS);
    triggerResyncCheck("third");
    await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS);
    expect(detectPublicIp).toHaveBeenCalledTimes(2);
  });

  test("backs off automatic checks after the IP service rate-limits us (429)", async () => {
    // First check: IP detection reports a 429 → enter backoff.
    detectPublicIp.mockRejectedValue(
      Object.assign(new Error("HTTP 429"), { code: "IP_DETECTION_FAILED" })
    );

    const { triggerResyncCheck, RESYNC_DEBOUNCE_MS, MIN_CHECK_INTERVAL_MS, RATE_LIMIT_BACKOFF_MS } =
      await freshCore();

    triggerResyncCheck("first");
    await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS);
    expect(detectPublicIp).toHaveBeenCalledTimes(1);
    expect(syncVpnLocation).not.toHaveBeenCalled();

    // A trigger past the min-interval floor but still within the backoff window
    // is suppressed (no further IP detection).
    await vi.advanceTimersByTimeAsync(MIN_CHECK_INTERVAL_MS);
    triggerResyncCheck("during-backoff");
    await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS);
    expect(detectPublicIp).toHaveBeenCalledTimes(1);

    // Once the backoff window elapses, checks resume.
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_BACKOFF_MS);
    triggerResyncCheck("after-backoff");
    await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS);
    expect(detectPublicIp).toHaveBeenCalledTimes(2);
  });
});
