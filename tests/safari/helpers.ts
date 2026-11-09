/**
 * Shared setup for the Safari suite (vitest.safari.config.ts compiles
 * `__SAFARI__` to true, so the real `siteGroupsAvailable()`, the app bridge's
 * native calls and the background's Safari spawn block all run).
 */
import { vi, type Mock } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "@/shared/types/settings";
import { installLocalStore, type LocalStore } from "../helpers/site-groups";

export const GOOGLE = "geosite:google";
export const EXACT = "=mail.example.com";
export const LINK_URL = "https://lists.example.org/rules/direct-list.txt";
export const LINK = `list:${LINK_URL}`;

export const DAY = 24 * 60 * 60_000;

export function settingsWith(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, enabled: true, onboardingCompleted: true, ...overrides };
}

/** `browser.runtime.sendNativeMessage`, which the shared setup doesn't define. */
export type NativeMock = Mock<(app: string, message: Record<string, unknown>) => Promise<unknown>>;

export function installNative(
  answer: (message: Record<string, unknown>) => unknown = () => undefined
): NativeMock {
  const native: NativeMock = vi.fn((_app: string, message: Record<string, unknown>) =>
    Promise.resolve(answer(message))
  );
  (browser.runtime as unknown as { sendNativeMessage: NativeMock }).sendNativeMessage = native;
  return native;
}

/** The native messages of `type`, in order. */
export function nativeMessages(native: NativeMock, type: string): Array<Record<string, unknown>> {
  return native.mock.calls.map(([, message]) => message).filter((m) => m.type === type);
}

export type Background = typeof import("@/background");

/**
 * Import a fresh background with `settings` (and any other `storage.local`
 * keys) stored. `runtime.onStartup` and `onInstalled` are mocks that never
 * fire, so only the module's top-level code runs, as on a Safari respawn.
 */
export async function bootSafari(
  settings: Settings,
  extra: Record<string, unknown> = {}
): Promise<{ bg: Background; store: LocalStore }> {
  vi.resetModules();
  const store = installLocalStore({ settings, ...extra });
  vi.mocked(browser.tabs.query).mockResolvedValue([]);
  vi.mocked(browser.alarms.get).mockResolvedValue(undefined);
  const bg = await import("@/background");
  return { bg, store };
}

/** Send a message through the background's router. */
export function send<T>(bg: Background, type: string, payload?: unknown): Promise<T> {
  return bg.handleMessage({ type, payload } as never, {}) as Promise<T>;
}
