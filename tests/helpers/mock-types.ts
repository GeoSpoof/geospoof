/**
 * Typed helpers for extracting values from Vitest mock calls.
 *
 * These eliminate `any` values that arise from accessing `.mock.calls[n][m]`
 * and centralise the cast so every test file doesn't need inline `as` casts.
 *
 * Most helpers accept an optional `mock` parameter. When omitted they default
 * to the corresponding global `browser.*` mock, which avoids detaching methods
 * from their objects and keeps `@typescript-eslint/unbound-method` happy.
 */

import type { Settings } from "@/shared/types/settings";
import type {
  Message,
  SetLocationPayload,
  GeocodeQueryPayload,
  UpdateSettingsPayload,
} from "@/shared/types/messages";
import type { SpoofedGeolocationPosition } from "@/shared/types/location";
import { expect, type Mock } from "vitest";

/** Any function that has been mocked by Vitest (has `.mock.calls`). */
export interface MockLike {
  mock: { calls: unknown[][] };
}

/**
 * Lightweight mock of the `browser` global used in popup property tests.
 * Covers only the subset of the WebExtension API that popup code touches.
 */
export interface MockBrowser {
  runtime: {
    sendMessage: Mock;
  };
}

/**
 * Lightweight mock of `document` used in popup property tests.
 * Extend locally if a test needs extra DOM methods (e.g. `addEventListener`).
 */
export interface MockDocument {
  getElementById: Mock;
}

/**
 * Helper to assign a value to a `global` property without `any`.
 * Usage: `assignGlobal("browser", mockBrowser);`
 *
 * Uses `Object.defineProperty` rather than plain assignment because some globals
 * are getter-only accessors — under the jsdom bundled with vitest 5, `document`
 * and `window` have no setter, so `globalThis.document = {...}` throws a
 * TypeError. Defining the property writable + configurable overrides the accessor
 * and keeps `deleteGlobal` (which uses `delete`) working.
 */
export function assignGlobal<T>(key: string, value: T): void {
  Object.defineProperty(globalThis, key, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

/**
 * Helper to delete a `global` property without `any`.
 * Usage: `deleteGlobal("browser");`
 */
export function deleteGlobal(key: string): void {
  delete (globalThis as unknown as Record<string, unknown>)[key];
}

// ---------------------------------------------------------------------------
// Safe mock accessors – access the global browser mock without detaching
// the method from its parent object.
// ---------------------------------------------------------------------------

function storageSetMock(): MockLike {
  // Access via index signature to avoid unbound-method on mock objects
  const local = browser.storage.local as unknown as Record<string, unknown>;
  return local["set"] as MockLike;
}

function tabsSendMessageMock(): MockLike {
  const tabs = browser.tabs as unknown as Record<string, unknown>;
  return tabs["sendMessage"] as MockLike;
}

// ---------------------------------------------------------------------------
// browser.storage.local.set  –  called with ({ settings: Settings })
// ---------------------------------------------------------------------------

interface StorageSetArg {
  settings: Settings;
}

/**
 * Return the `Settings` object from the Nth call to `browser.storage.local.set`.
 * Defaults to the first call. When `mock` is omitted the global browser mock is used.
 */
export function getSavedSettings(mock?: MockLike, callIndex = 0): Settings {
  const m = mock ?? storageSetMock();
  const arg = m.mock.calls[callIndex][0] as StorageSetArg;
  return arg.settings;
}

/**
 * Return the `Settings` from the *last* call to `browser.storage.local.set`.
 * When `mock` is omitted the global browser mock is used.
 */
export function getLastSavedSettings(mock?: MockLike): Settings {
  const m = mock ?? storageSetMock();
  const calls = m.mock.calls;
  const arg = calls[calls.length - 1][0] as StorageSetArg;
  return arg.settings;
}

// ---------------------------------------------------------------------------
// runtime.sendMessage  –  called with Message<Payload>
// ---------------------------------------------------------------------------

/**
 * Return a typed message from the Nth call to a `sendMessage` mock.
 */
export function getSentMessage<T = unknown>(mock: MockLike, callIndex = 0): Message<T> {
  return mock.mock.calls[callIndex][0] as Message<T>;
}

/** Shorthand for SET_LOCATION messages. */
export function getSetLocationMessage(mock: MockLike, callIndex = 0): Message<SetLocationPayload> {
  return getSentMessage<SetLocationPayload>(mock, callIndex);
}

/** Shorthand for GEOCODE_QUERY messages. */
export function getGeocodeQueryMessage(
  mock: MockLike,
  callIndex = 0
): Message<GeocodeQueryPayload> {
  return getSentMessage<GeocodeQueryPayload>(mock, callIndex);
}

// ---------------------------------------------------------------------------
// browser.tabs.sendMessage  –  called with (tabId, message)
// ---------------------------------------------------------------------------

/**
 * Return the message argument from the Nth call to `browser.tabs.sendMessage`.
 * tabs.sendMessage is called as sendMessage(tabId, message), so the message
 * is the second positional argument (index 1).
 * When `mock` is omitted the global browser mock is used.
 */
export function getBroadcastMessage(
  mock?: MockLike,
  callIndex = 0
): Message<UpdateSettingsPayload> {
  const m = mock ?? tabsSendMessageMock();
  return m.mock.calls[callIndex][1] as Message<UpdateSettingsPayload>;
}

/** Return the broadcast message from the *last* call. When `mock` is omitted the global browser mock is used. */
export function getLastBroadcastMessage(mock?: MockLike): Message<UpdateSettingsPayload> {
  const m = mock ?? tabsSendMessageMock();
  const calls = m.mock.calls;
  return calls[calls.length - 1][1] as Message<UpdateSettingsPayload>;
}

// ---------------------------------------------------------------------------
// Geolocation position callbacks
// ---------------------------------------------------------------------------

/**
 * Return the `SpoofedGeolocationPosition` passed to a position callback mock.
 */
export function getPositionFromCallback(mock: MockLike, callIndex = 0): SpoofedGeolocationPosition {
  return mock.mock.calls[callIndex][0] as SpoofedGeolocationPosition;
}

// ---------------------------------------------------------------------------
// fetch mock helpers
// ---------------------------------------------------------------------------

/** Access the global fetch mock without `(global as any)`. */
export function fetchMock(): Mock {
  return globalThis.fetch as unknown as Mock;
}

/** Return the URL string from the Nth call to a fetch mock. */
export function getFetchUrl(mock: MockLike, callIndex = 0): string {
  return mock.mock.calls[callIndex][0] as string;
}

/** Return the options/init object from the Nth call to a fetch mock. */
export function getFetchOptions(
  mock: MockLike,
  callIndex = 0
): RequestInit & { headers: Record<string, string> } {
  return mock.mock.calls[callIndex][1] as RequestInit & { headers: Record<string, string> };
}

// ---------------------------------------------------------------------------
// CustomEvent dispatch helpers
// ---------------------------------------------------------------------------

/** Return the CustomEvent from the Nth call to a dispatchEvent mock. */
export function getDispatchedEvent(mock: MockLike, callIndex = 0): CustomEvent {
  return mock.mock.calls[callIndex][0] as CustomEvent;
}

// ---------------------------------------------------------------------------
// Assertion helpers – wrap expect() calls on browser mocks so test files
// never need to detach methods (avoids @typescript-eslint/unbound-method).
// ---------------------------------------------------------------------------

/** expect(browser.storage.local.set) without detaching the method. */
export function expectStorageSet() {
  const local = browser.storage.local as unknown as Record<string, unknown>;
  return expect(local["set"]);
}

/** expect(browser.tabs.sendMessage) without detaching the method. */
export function expectTabsSendMessage() {
  const tabs = browser.tabs as unknown as Record<string, unknown>;
  return expect(tabs["sendMessage"]);
}

/** expect(browser.privacy.network.webRTCIPHandlingPolicy.set) without detaching. */
export function expectWebRTCPolicySet() {
  const policy = browser.privacy.network.webRTCIPHandlingPolicy as unknown as Record<
    string,
    unknown
  >;
  return expect(policy["set"]);
}

/** expect(browser.privacy.network.webRTCIPHandlingPolicy.clear) without detaching. */
export function expectWebRTCPolicyClear() {
  const policy = browser.privacy.network.webRTCIPHandlingPolicy as unknown as Record<
    string,
    unknown
  >;
  return expect(policy["clear"]);
}

/** expect(browser.action.setBadgeBackgroundColor) without detaching. */
export function expectBadgeColor() {
  const action = browser.action as unknown as Record<string, unknown>;
  return expect(action["setBadgeBackgroundColor"]);
}

/** expect(browser.action.setBadgeText) without detaching. */
export function expectBadgeText() {
  const action = browser.action as unknown as Record<string, unknown>;
  return expect(action["setBadgeText"]);
}

/** Return the number of calls to browser.tabs.sendMessage without detaching. */
export function tabsSendMessageCallCount(): number {
  return tabsSendMessageMock().mock.calls.length;
}
