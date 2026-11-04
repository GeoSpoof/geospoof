/**
 * "Browser-level spoofing" opt-in (Chrome only).
 *
 * The default spoofing path patches JS APIs from a page-world content script.
 * The Chromium-only alternative attaches `chrome.debugger` and drives CDP's
 * `Emulation.setTimezoneOverride`, which sets the timezone in the page's
 * renderer process (and, on Chrome 125+, in cross-origin iframes' processes),
 * so it also covers the URL / module workers the content-script path can't
 * patch on Chromium. Geolocation stays on the injected path. It doesn't reach a
 * tab's first page, or the first scripts after a cross-site navigation, in
 * time (Known Limitations 3 and 15 in docs/API.md). The cost is Chrome's
 * persistent "GeoSpoof started debugging this browser" bar, so it's strictly
 * opt-in.
 *
 * Unlike the Firefox `userScripts` toggle, the `debugger` permission itself is
 * declared *required* in the Chromium manifest (Chrome forbids it as an
 * optional permission, and it adds no new install warning over the existing
 * `<all_urls>`), so the toggle is just a setting — no permission request for the
 * core capability. What we *do* request at runtime is the optional
 * `webNavigation` permission, which lets the background attach on
 * `onBeforeNavigate` and re-apply on `onCommitted` / `onErrorOccurred`.
 * It's best-effort: if the user declines it, debugger mode still works via a
 * slightly-later `tabs.onUpdated` attach, so we enable the mode regardless.
 *
 * Everything is gated on `__CHROMIUM__` and feature-detected, so it compiles
 * out and no-ops on Firefox/Safari.
 */

const WEB_NAVIGATION_PERMISSION: { permissions: string[] } = { permissions: ["webNavigation"] };

/** Narrow access to the optional `browser.permissions` namespace. */
function permissionsApi(): {
  request: (p: { permissions: string[] }) => Promise<boolean>;
  remove: (p: { permissions: string[] }) => Promise<boolean>;
} | null {
  type PermsApi = {
    request: (p: { permissions: string[] }) => Promise<boolean>;
    remove: (p: { permissions: string[] }) => Promise<boolean>;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
  const api = (browser as any).permissions as PermsApi | undefined;
  if (api && typeof api.request === "function" && typeof api.remove === "function") {
    return api;
  }
  return null;
}

/** Storage key for the one-time "how to hide the debugging bar" note's dismissed state. */
const BANNER_DISMISSED_KEY = "debuggerBannerHelpDismissed";

/** Read whether the user has dismissed the debugging-bar help note for the current enablement. */
async function isBannerDismissed(): Promise<boolean> {
  try {
    const result = await browser.storage.local.get(BANNER_DISMISSED_KEY);
    return result[BANNER_DISMISSED_KEY] === true;
  } catch {
    return false;
  }
}

/** Show or hide the dismissible debugging-bar help note. */
function showBannerHelp(visible: boolean): void {
  const note = document.getElementById("debuggerBannerHelp");
  if (note) note.style.display = visible ? "" : "none";
}

/**
 * Reveal the Chrome-only "Engine-level Spoofing" row and sync its checked state
 * to the persisted `debuggerModeEnabled` setting. Also reconciles the one-time
 * debugging-bar help note: it shows while the mode is on and hasn't been
 * dismissed for this enablement (the background resets that flag on each
 * enable). Safe to call on every popup load; no-ops on non-Chromium builds.
 */
export function reflectDebuggerModeState(enabled: boolean): void {
  if (!__CHROMIUM__) return;
  const row = document.getElementById("debuggerModeRow");
  const toggle = document.getElementById("debuggerModeToggle") as HTMLInputElement | null;
  if (!row || !toggle) return;

  row.style.display = "";
  toggle.checked = enabled;

  if (!enabled) {
    showBannerHelp(false);
    return;
  }
  // Mode on: show the note unless it was dismissed for this enablement.
  void isBannerDismissed().then((dismissed) => showBannerHelp(!dismissed));
}

/**
 * Attach the change handler that toggles browser-level spoofing. On enable it
 * requests the optional `webNavigation` permission (synchronously, to preserve
 * the user gesture) and enables the mode regardless of the grant result; on
 * disable it turns the mode off and then releases the permission. No-ops on
 * non-Chromium builds.
 */
export function wireDebuggerModeToggle(): void {
  if (!__CHROMIUM__) return;
  const toggle = document.getElementById("debuggerModeToggle") as HTMLInputElement | null;
  if (!toggle) return;

  // Wire the debugging-bar help note's close button: dismiss for this
  // enablement (persisted) and hide it. It re-shows on the next enable because
  // the background resets the flag in handleSetDebuggerMode.
  document.getElementById("debuggerBannerHelpClose")?.addEventListener("click", () => {
    showBannerHelp(false);
    void browser.storage.local.set({ [BANNER_DISMISSED_KEY]: true }).catch(() => undefined);
  });

  toggle.addEventListener("change", (e: Event) => {
    const target = e.target as HTMLInputElement;
    const wantOn = target.checked;
    const api = permissionsApi();

    if (wantOn) {
      // Show the "how to hide the debugging bar" note right away (covers the
      // case where the popup stays open). If the permission prompt closes the
      // popup, the background's reset of the dismissed flag makes it re-show on
      // reopen via reflectDebuggerModeState.
      showBannerHelp(true);

      // Persist + apply the mode IMMEDIATELY (fire-and-forget, not chained on
      // the permission request). Chrome closes the action popup the moment it
      // shows the webNavigation prompt, which destroys this script's context —
      // so anything chained AFTER the request would never run and the toggle
      // wouldn't stick. The background handles this one-way message
      // independently of the popup's lifetime, so the mode is enabled and the
      // toggle reflects it on reopen whether or not the popup closed.
      void browser.runtime
        .sendMessage({ type: "SET_DEBUGGER_MODE", payload: { enabled: true } })
        .catch((error: unknown) => console.error("Failed to enable debugger mode:", error));

      // Request webNavigation as a best-effort enhancement (an earlier attach,
      // and re-applies at commit / abort). Called synchronously so Chrome counts
      // it as a user gesture.
      // The mode works via the tabs.onUpdated fallback even if this is denied,
      // and the background binds onBeforeNavigate via permissions.onAdded if
      // it's granted — so we don't need the result here.
      if (api) void api.request(WEB_NAVIGATION_PERMISSION).catch(() => undefined);
    } else {
      showBannerHelp(false);
      void browser.runtime
        .sendMessage({ type: "SET_DEBUGGER_MODE", payload: { enabled: false } })
        .catch((error: unknown) => console.error("Failed to disable debugger mode:", error));
      // Release the optional permission we requested when enabling. remove()
      // shows no prompt (doesn't close the popup) and needs no user gesture.
      if (api) void api.remove(WEB_NAVIGATION_PERMISSION).catch(() => undefined);
    }
  });
}
