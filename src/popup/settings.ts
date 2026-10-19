/**
 * Popup Settings
 * Load settings, check page/injection status, and restricted URL detection.
 */

import type { Settings } from "@/shared/types/settings";
import { DEFAULT_ACCURACY_M } from "@/shared/types/settings";
import { resolveAccuracy } from "@/shared/accuracy/resolver";
import { detectDeviceClass } from "@/shared/accuracy/device-class";
import { computeEffectiveSiteLocations } from "@/shared/utils/scope";
import { updateDetailsView, updateStatusBadge, displayLocation } from "./ui";
import { showOnboarding } from "./onboarding";
import { t } from "./i18n";
import { renderFavorites } from "./favorites";
import { renderScope, renderScopeLoadError } from "./scope";
import { renderSiteLocations } from "./site-locations";
import { reflectEarlyProtectionState } from "./early-protection";
import { reflectDebuggerModeState } from "./debugger-mode";
import { restoreAccuracyControl } from "./accuracy";
import { restorePrecisionCadenceControl, restorePrecisionControl } from "./precision";
import { restoreLocaleControl } from "./locale";

/**
 * Apply a theme class to the document body.
 * "system" removes explicit classes and falls back to the OS media query.
 */
export function applyTheme(theme: "system" | "light" | "dark"): void {
  document.body.classList.remove("theme-light", "theme-dark");
  if (theme === "light") document.body.classList.add("theme-light");
  if (theme === "dark") document.body.classList.add("theme-dark");
}

/** Fetch the current settings from the background — the popup's single read path. */
export async function requestSettings(): Promise<Settings> {
  return (await browser.runtime.sendMessage({ type: "GET_SETTINGS" })) as Settings;
}

/**
 * Load current settings on popup open and reflect them into the UI.
 *
 * Accepts an already-fetched `preloaded` object so the init path can resolve
 * the UI language from settings and still reuse the same fetch here (avoiding a
 * duplicate GET_SETTINGS round-trip).
 */
export async function loadSettings(preloaded?: Settings): Promise<void> {
  try {
    const settings = preloaded ?? (await requestSettings());
    // On Safari the containing app owns onboarding (and on iOS the home-screen
    // Setup card), so suppress the popup's duplicate overlay. Firefox/Chromium
    // have no app, so the popup onboarding is the only first-run guidance.
    if (!settings.onboardingCompleted && !__SAFARI__) {
      showOnboarding();
    }

    const protectionToggle = document.getElementById("protectionToggle") as HTMLInputElement | null;
    const webrtcToggle = document.getElementById("webrtcToggle") as HTMLInputElement | null;
    const preserveGeoPromptToggle = document.getElementById(
      "preserveGeoPromptToggle"
    ) as HTMLInputElement | null;

    if (protectionToggle) {
      protectionToggle.checked = settings.enabled;
    }
    if (webrtcToggle) {
      webrtcToggle.checked = settings.webrtcProtection;
    }
    if (preserveGeoPromptToggle) {
      preserveGeoPromptToggle.checked = settings.preserveGeolocationPrompt;
    }

    // WebRTC Protection is now implemented at the content-script layer
    // (see src/content/injected/webrtc.ts), so it works on every engine
    // including Safari — unlike the previous `browser.privacy`-only
    // implementation. The toggle stays visible everywhere; the
    // background-level privacy API call gracefully degrades to a
    // no-op on engines that don't expose it.

    updateStatusBadge(settings.enabled);

    if (settings.location) {
      displayLocation(settings.location, settings.locationName);
    } else {
      const nameEl = document.getElementById("locationName");
      const coordsEl = document.getElementById("locationCoords");
      if (nameEl) nameEl.textContent = t("location_none") || "No location set";
      if (coordsEl) coordsEl.textContent = "—";
    }

    // Show clear button only when location is set and VPN sync is not active.
    // Use empty string (not "block") so the CSS `display: inline-flex` wins.
    const clearBtn = document.getElementById("clearLocationBtn");
    if (clearBtn) {
      clearBtn.style.display = settings.location && !settings.vpnSyncEnabled ? "" : "none";
    }

    renderFavorites(settings);

    // Safari/iOS Pro gate: when the app signals the user isn't entitled to
    // Pro-only config (per-site filtering, custom accuracy), the popup disables
    // those controls and explains they're Pro. The background already forces
    // the safe behavior (scope "all", auto accuracy); this is UI clarity only.
    // `__SAFARI__` compiles it out on Chrome/Firefox, and proFeaturesBlocked is
    // only ever true for a non-Pro iOS user (macOS sends false).
    const proLocked = __SAFARI__ && settings.proFeaturesBlocked === true;

    renderScope(settings, proLocked);
    await renderSiteLocations(settings, proLocked);

    // Preserve-location-prompts is Pro-gated on iOS Safari (parity with custom
    // accuracy / per-site filtering). For a non-Pro user the background already
    // forces the free behavior (auto-grant, no prompt); this disables the toggle
    // and shows the Pro note so the popup explains why it can't be turned on.
    if (preserveGeoPromptToggle) {
      preserveGeoPromptToggle.disabled = proLocked;
      if (proLocked) preserveGeoPromptToggle.checked = false;
    }
    const preserveGeoPromptProNote = document.getElementById("preserveGeoPromptProNote");
    if (preserveGeoPromptProNote) {
      preserveGeoPromptProNote.style.display = proLocked ? "block" : "none";
    }

    updateDetailsView(settings);

    // Restore debug logging toggle state
    const debugLoggingToggle = document.getElementById(
      "debugLoggingToggle"
    ) as HTMLInputElement | null;
    if (debugLoggingToggle) {
      debugLoggingToggle.checked = !!settings.debugLogging;
    }

    // Restore verbosity selector state
    const verbositySelector = document.getElementById("verbositySelector");
    const verbosityLevel = document.getElementById("verbosityLevel") as HTMLSelectElement | null;
    if (verbositySelector) {
      verbositySelector.style.display = settings.debugLogging ? "block" : "none";
    }
    if (verbosityLevel && settings.verbosityLevel) {
      verbosityLevel.value = settings.verbosityLevel;
    }

    // Restore theme selector state
    const themeSelect = document.getElementById("themeSelect") as HTMLSelectElement | null;
    if (themeSelect) {
      themeSelect.value = settings.theme ?? "system";
    }
    applyTheme(settings.theme ?? "system");

    // Restore language selector state. "" selects the "System" option (follow
    // the browser UI language); a locale code selects that language. The
    // option elements are populated at startup from SUPPORTED_UI_LOCALES.
    const languageSelect = document.getElementById("languageSelect") as HTMLSelectElement | null;
    if (languageSelect) {
      languageSelect.value = settings.uiLanguage ?? "";
    }

    // Restore accuracy control state from the stored accuracySetting. Pass the
    // currently-resolved accuracy (the ±Nm in effect) so selecting "Custom"
    // pre-fills the input with the value the user currently sees.
    const resolvedAccuracy = settings.location
      ? resolveAccuracy({
          setting: settings.accuracySetting ?? { mode: "auto" },
          deviceClass: detectDeviceClass(navigator),
          seed: settings.accuracySeed,
          latitude: settings.location.latitude,
          longitude: settings.location.longitude,
        })
      : DEFAULT_ACCURACY_M;
    restoreAccuracyControl(settings.accuracySetting, resolvedAccuracy, proLocked);

    // Restore the location-precision dropdown from the stored setting.
    // Approximate location is Pro-gated on iOS Safari (parity with custom
    // accuracy); a non-Pro user sees it disabled and forced to Exact.
    restorePrecisionControl(settings.locationPrecision, proLocked);
    // Restore "Pick a new point" after the precision select, since its
    // visibility depends on it. Hidden and disabled behind the same Pro lock.
    restorePrecisionCadenceControl(settings.precisionCadence, proLocked);

    // Restore the Reported Language control. Pro-gated on Safari like the two
    // above; a non-entitled user sees it disabled and forced to Off, which is
    // what the background independently enforces.
    restoreLocaleControl(settings.localeSpoofing, proLocked);

    // Firefox-only: reveal the "Instant timezone protection" toggle and sync it
    // to whether the optional userScripts permission is currently granted.
    void reflectEarlyProtectionState();

    // Chrome-only: reveal the "Browser-level spoofing" toggle and sync it to the
    // persisted debuggerModeEnabled setting.
    reflectDebuggerModeState(settings.debuggerModeEnabled);

    // Restore VPN sync toggle state (Req 4.1–4.4)
    const vpnSyncToggle = document.getElementById("vpnSyncToggle") as HTMLInputElement | null;
    const inputModeTabs = document.getElementById("inputModeTabs");
    const vpnPanel = document.getElementById("vpnSyncMode");
    const searchPanel = document.getElementById("searchMode");
    const coordsPanel = document.getElementById("coordsMode");

    if (vpnSyncToggle) {
      vpnSyncToggle.checked = !!settings.vpnSyncEnabled;
    }

    if (settings.vpnSyncEnabled) {
      if (inputModeTabs) inputModeTabs.style.display = "none";
      if (searchPanel) searchPanel.style.display = "none";
      if (coordsPanel) coordsPanel.style.display = "none";
      if (vpnPanel) vpnPanel.style.display = "block";

      // If a previous sync succeeded, show re-sync button instead of sync button
      if (settings.locationName) {
        const syncBtn = document.getElementById("vpnSyncButton");
        const resyncBtn = document.getElementById("vpnResyncButton");

        if (syncBtn) syncBtn.style.display = "none";
        if (resyncBtn) resyncBtn.style.display = "block";
      }
    } else {
      // Not in VPN sync mode: show the tabs and keep whichever input mode the
      // user currently has selected (default: search). Reloading settings after
      // applying a location must NOT force the view back to search, or the
      // coordinates tab would collapse out from under the user every time they
      // paste coordinates or click Set Location.
      const coordsTabActive = document
        .getElementById("coordsModeTab")
        ?.classList.contains("active");
      if (inputModeTabs) inputModeTabs.style.display = "";
      if (searchPanel) searchPanel.style.display = coordsTabActive ? "none" : "block";
      if (coordsPanel) coordsPanel.style.display = coordsTabActive ? "block" : "none";
      if (vpnPanel) vpnPanel.style.display = "none";
    }

    const warningMessage = document.getElementById("warningMessage");
    if (warningMessage) {
      // Site locations still spoof their own sites without a main location,
      // so the warning would overstate the problem.
      const hasSiteLocations =
        computeEffectiveSiteLocations(settings.siteLocations, settings.proFeaturesBlocked).length >
        0;
      if (settings.enabled && !settings.location && !hasSiteLocations) {
        warningMessage.style.display = "block";
        warningMessage.textContent =
          t("warning_noLocationSet") || "⚠️ Protection enabled but no location set";
      } else {
        warningMessage.style.display = "none";
      }
    }

    checkPageStatus().catch((err: unknown) => {
      console.error("Failed to check page status:", err);
    });
  } catch (error: unknown) {
    console.error("Failed to load settings:", error);
    // Surface the scope-load error state: default selector to "all" with an
    // inline "settings could not be loaded" message (Req 13.3).
    renderScopeLoadError();
  }
}

/** Check if current page is restricted or has injection issues */
export async function checkPageStatus(): Promise<void> {
  try {
    const tabs = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tabs.length === 0) return;

    const currentTab = tabs[0];

    if (isRestrictedUrl(currentTab.url)) {
      const restrictedNotice = document.getElementById("restrictedPageNotice");
      const injectionWarning = document.getElementById("injectionWarning");
      if (restrictedNotice) restrictedNotice.style.display = "block";
      if (injectionWarning) injectionWarning.style.display = "none";
      return;
    }

    const restrictedNotice = document.getElementById("restrictedPageNotice");
    if (restrictedNotice) restrictedNotice.style.display = "none";

    const settings = (await browser.runtime.sendMessage({
      type: "GET_SETTINGS",
    })) as Settings;
    if (settings.enabled) {
      await checkInjectionStatus();
    }
  } catch (error: unknown) {
    console.error("Failed to check page status:", error);
  }
}

/** Check if content script is properly injected in current tab */
export async function checkInjectionStatus(): Promise<void> {
  try {
    const tabs = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tabs.length === 0) return;

    const currentTab = tabs[0];

    if (isRestrictedUrl(currentTab.url)) {
      return;
    }

    // Live PING via background's CHECK_TAB_INJECTION instead of stale badge text
    const result = (await browser.runtime.sendMessage({
      type: "CHECK_TAB_INJECTION",
      payload: { tabId: currentTab.id },
    })) as { injected: boolean; error: string | null };

    const warningEl = document.getElementById("injectionWarning");
    if (warningEl) {
      warningEl.style.display = result.injected ? "none" : "block";
    }
  } catch (error: unknown) {
    console.error("Failed to check injection status:", error);
  }
}

/**
 * Check if a URL is a restricted page where extensions cannot run.
 */
export function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true;

  const restrictedPrefixes: string[] = [
    "about:",
    "moz-extension:",
    "chrome:",
    "chrome-extension:",
    "edge:",
    "resource:",
    "view-source:",
    "data:",
    "blob:",
    "file:",
  ];

  const restrictedDomains: string[] = [
    "addons.mozilla.org",
    "accounts.firefox.com",
    "testpilot.firefox.com",
    "chrome.google.com",
  ];

  for (const prefix of restrictedPrefixes) {
    if (url.startsWith(prefix)) {
      return true;
    }
  }

  try {
    const urlObj = new URL(url);
    for (const domain of restrictedDomains) {
      if (urlObj.hostname === domain || urlObj.hostname.endsWith("." + domain)) {
        return true;
      }
    }
  } catch {
    return true;
  }

  return false;
}
