/**
 * Minimal ambient declarations for the Chromium-only `chrome.debugger` and
 * `chrome.webNavigation` APIs that GeoSpoof's browser-level (Chrome DevTools
 * Protocol) spoofing uses.
 *
 * Why hand-rolled instead of depending on `chrome-types` / `@types/chrome`:
 * those packages declare the *entire* global `chrome` namespace, which would
 * expose `chrome.*` across this multi-browser codebase and invite accidental
 * use of Chrome-only APIs that silently break the Firefox/Safari builds. We
 * deliberately go through `browser` (webextension-polyfill) + `__CHROMIUM__`
 * guards everywhere else, and keep small hand-rolled ambient decls (cf.
 * `temporal.d.ts`, the `geobuf`/`pbf` module declarations). This file curates
 * only the surface we call.
 *
 * SOURCE OF TRUTH: signatures below mirror `chrome-types@0.1.429` (published by
 * Google, auto-generated from the Chromium source, MV3-only, generated
 * 2026-05-20). To re-verify: `npm pack chrome-types` and diff the `_debugger`
 * and `webNavigation` namespaces. Notable verified facts baked in here:
 *   - `attach`/`detach`/`sendCommand`/`getTargets` are promise-returning since
 *     Chrome 96 (callbacks still exist for back-compat; we use promises).
 *   - `sendCommand`'s target is a `DebuggerSession` and it resolves to
 *     `{[name]: any} | undefined`.
 *   - `onDetach`'s reason is the union `"target_closed" | "canceled_by_user"`.
 *   - `onEvent`'s source is a `DebuggerSession`; a `sessionId` on it (and on
 *     `sendCommand`'s target) names a child session (flat sessions, Chrome 125+).
 *
 * Both namespaces are typed optional on the `chrome` global: `webNavigation` is
 * an optional permission (the namespace is absent until granted), and the whole
 * file is only referenced from `__CHROMIUM__`-guarded code that is compiled out
 * of the other builds. Callers must feature-detect before use.
 */

declare namespace ChromeDebugger {
  /** Debuggee identifier. Either tabId, extensionId or targetId must be specified. */
  interface Debuggee {
    tabId?: number;
    extensionId?: string;
    targetId?: string;
  }

  /**
   * Debugger session identifier (superset of Debuggee with an optional CDP
   * sessionId). This is the target type `sendCommand` accepts.
   */
  interface DebuggerSession {
    tabId?: number;
    extensionId?: string;
    targetId?: string;
    sessionId?: string;
  }

  type TargetInfoType = "page" | "background_page" | "worker" | "other";

  /** Why a debugging session ended. */
  type DetachReason = "target_closed" | "canceled_by_user";

  /** Debug target information returned by getTargets(). */
  interface TargetInfo {
    type: TargetInfoType;
    id: string;
    /** Defined when type === "page". */
    tabId?: number;
    extensionId?: string;
    /** True if a debugger is already attached to this target. */
    attached: boolean;
    title: string;
    url: string;
    faviconUrl?: string;
  }

  interface DebuggerEvent<T extends (...args: never[]) => void> {
    addListener(callback: T): void;
    removeListener(callback: T): void;
    hasListener(callback: T): boolean;
  }

  interface Static {
    attach(target: Debuggee, requiredVersion: string): Promise<void>;
    detach(target: Debuggee): Promise<void>;
    sendCommand(
      target: DebuggerSession,
      method: string,
      commandParams?: { [name: string]: unknown }
    ): Promise<{ [name: string]: unknown } | undefined>;
    getTargets(): Promise<TargetInfo[]>;
    onDetach: DebuggerEvent<(source: Debuggee, reason: DetachReason) => void>;
    /**
     * CDP events. `source.sessionId` is set when the event comes from a child
     * (flat) session within the root debuggee session (Chrome 125+).
     */
    onEvent: DebuggerEvent<(source: DebuggerSession, method: string, params?: object) => void>;
  }
}

declare namespace ChromeWebNavigation {
  /** The subset of the onBeforeNavigate details object GeoSpoof reads. */
  interface OnBeforeNavigateDetails {
    tabId: number;
    url: string;
    /** 0 = top-level navigation; > 0 = subframe. */
    frameId: number;
  }

  interface Static {
    onBeforeNavigate: {
      addListener(callback: (details: OnBeforeNavigateDetails) => void): void;
      removeListener(callback: (details: OnBeforeNavigateDetails) => void): void;
      hasListener(callback: (details: OnBeforeNavigateDetails) => void): boolean;
    };
  }
}

declare const chrome: {
  /** Present on Chromium (the `debugger` permission is declared required there). */
  debugger?: ChromeDebugger.Static;
  /** Present only once the optional `webNavigation` permission has been granted. */
  webNavigation?: ChromeWebNavigation.Static;
  runtime?: {
    lastError?: { message?: string };
  };
};
