/**
 * Vitest global test setup file
 * Provides baseline browser WebExtension API mocks.
 * Individual test files can override specific mocks in beforeEach as needed.
 */

import { vi, beforeEach } from "vitest";

// In-memory storage backing for the mock
const storageData: Record<string, unknown> = {};
const sessionStorageData: Record<string, unknown> = {};

// Mock browser WebExtension API
const browserMock: typeof browser = {
  storage: {
    local: {
      get: vi.fn((key: string) => {
        if (key === "settings") {
          return Promise.resolve({ settings: storageData.settings });
        }
        return Promise.resolve({});
      }),
      set: vi.fn((obj: Record<string, unknown>) => {
        if (obj.settings) {
          storageData.settings = obj.settings;
        }
        return Promise.resolve();
      }),
      remove: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn(() => {
        for (const key of Object.keys(storageData)) {
          delete storageData[key];
        }
        return Promise.resolve();
      }),
    },
    session: {
      get: vi.fn((keyOrNull: string | null) => {
        if (keyOrNull === null) {
          return Promise.resolve({ ...sessionStorageData });
        }
        return Promise.resolve(
          keyOrNull in sessionStorageData ? { [keyOrNull]: sessionStorageData[keyOrNull] } : {}
        );
      }),
      set: vi.fn((obj: Record<string, unknown>) => {
        Object.assign(sessionStorageData, obj);
        return Promise.resolve();
      }),
      remove: vi.fn((keys: string | string[]) => {
        const keyList = Array.isArray(keys) ? keys : [keys];
        for (const k of keyList) {
          delete sessionStorageData[k];
        }
        return Promise.resolve();
      }),
      clear: vi.fn(() => {
        for (const key of Object.keys(sessionStorageData)) {
          delete sessionStorageData[key];
        }
        return Promise.resolve();
      }),
    },
  },
  runtime: {
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    onInstalled: { addListener: vi.fn() },
    onStartup: { addListener: vi.fn() },
    getURL: vi.fn((path: string) => `moz-extension://test/${path}`),
    sendMessage: vi.fn(),
    getManifest: vi.fn(() => ({ version: "1.0.0", name: "GeoSpoof" })),
  },
  tabs: {
    query: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    onCreated: { addListener: vi.fn() },
    onUpdated: { addListener: vi.fn() },
  },
  action: {
    setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
    setBadgeText: vi.fn().mockResolvedValue(undefined),
  },
  scripting: {
    executeScript: vi.fn().mockResolvedValue([]),
  },
  alarms: {
    create: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(true),
    clearAll: vi.fn().mockResolvedValue(true),
    get: vi.fn().mockResolvedValue(undefined),
    getAll: vi.fn().mockResolvedValue([]),
    onAlarm: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  privacy: {
    network: {
      webRTCIPHandlingPolicy: {
        set: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue({}),
        clear: vi.fn().mockResolvedValue(undefined),
      },
      peerConnectionEnabled: {
        set: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue({}),
        clear: vi.fn().mockResolvedValue(undefined),
      },
    },
  },
} as unknown as typeof browser;

/**
 * Expose the mock on globalThis so test files and the background module
 * see it as the real `browser` WebExtension API.
 */
Object.assign(globalThis, {
  browser: browserMock,
  chrome: browserMock,
  fetch: vi.fn(),
});

/**
 * Export storage helpers so test files that need direct access to the
 * in-memory storage backing can import them instead of reaching through
 * `(global as any).browser.storage.local.data`.
 */
export { storageData, sessionStorageData };

/**
 * Reset all mocks and clear in-memory storage between tests.
 * Individual test files can add their own beforeEach on top of this.
 */
beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(storageData)) {
    delete storageData[key];
  }
  for (const key of Object.keys(sessionStorageData)) {
    delete sessionStorageData[key];
  }
});
