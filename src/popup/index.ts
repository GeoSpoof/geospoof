/**
 * Popup UI Script — Entry Point
 * Wires up event listeners and initializes the popup.
 */

import type { GeocodeResponse } from "@/shared/types/messages";
import { loadSettings, requestSettings, applyTheme } from "./settings";
import { closeOnboarding } from "./onboarding";
import { displaySearchResults } from "./search";
import { updateStatusBadge, renderWebRTCDetails, clearChildren } from "./ui";
import { handleVpnSync } from "./vpn-sync";
import { wireEarlyProtectionToggle } from "./early-protection";
import { wireDebuggerModeToggle } from "./debugger-mode";
import { applyI18n, t, initI18n, resetI18nOverride, browserUiLanguage } from "./i18n";
import { localizeWebsiteLinks } from "./website-links";
import { initAccuracyControl } from "./accuracy";
import { initPrecisionCadenceControl, initPrecisionControl } from "./precision";
import { initLocaleControl } from "./locale";
import { wireCoordinatePaste } from "./coord-paste";
import { SUPPORTED_UI_LOCALES, resolveUiLocale } from "@/shared/i18n/locales";

// --- Location setting ---

async function setLocation(latitude: number, longitude: number): Promise<void> {
  const container = document.getElementById("searchResults");

  try {
    if (container) {
      clearChildren(container);
      const loadingDiv = document.createElement("div");
      loadingDiv.className = "loading";
      const spinner = document.createElement("div");
      spinner.className = "spinner";
      loadingDiv.appendChild(spinner);
      loadingDiv.appendChild(
        document.createTextNode(t("search_settingLocation") || "Setting location...")
      );
      container.appendChild(loadingDiv);
    }

    await browser.runtime.sendMessage({
      type: "SET_LOCATION",
      payload: { latitude, longitude },
    });

    const searchInput = document.getElementById("locationSearch") as HTMLInputElement | null;
    if (searchInput) searchInput.value = "";
    if (container) clearChildren(container);

    await loadSettings();
  } catch (error: unknown) {
    console.error("Failed to set location:", error);
    if (container) clearChildren(container);
    alert(t("search_setLocationFailed") || "Failed to set location. Please try again.");
  }
}

// --- Event Listeners ---

// Protection toggle
document.getElementById("protectionToggle")?.addEventListener("change", (e: Event) => {
  const target = e.target as HTMLInputElement;
  const enabled = target.checked;

  void (async () => {
    try {
      await browser.runtime.sendMessage({
        type: "SET_PROTECTION_STATUS",
        payload: { enabled },
      });

      updateStatusBadge(enabled);
      await loadSettings();
    } catch (error: unknown) {
      console.error("Failed to set protection status:", error);
      target.checked = !enabled;
    }
  })();
});

// WebRTC toggle
document.getElementById("webrtcToggle")?.addEventListener("change", (e: Event) => {
  const target = e.target as HTMLInputElement;
  const enabled = target.checked;

  void (async () => {
    try {
      await browser.runtime.sendMessage({
        type: "SET_WEBRTC_PROTECTION",
        payload: { enabled },
      });

      const detailWebRTC = document.getElementById("detailWebRTC");
      if (detailWebRTC) {
        renderWebRTCDetails(detailWebRTC, enabled);
      }
    } catch (error: unknown) {
      console.error("Failed to set WebRTC protection:", error);
      target.checked = !enabled;
      alert(
        t("webrtc_configFailed") ||
          "Failed to configure WebRTC protection. Check extension permissions."
      );
    }
  })();
});

// Preserve permission prompts toggle
document.getElementById("preserveGeoPromptToggle")?.addEventListener("change", (e: Event) => {
  const target = e.target as HTMLInputElement;
  const enabled = target.checked;

  void (async () => {
    try {
      await browser.runtime.sendMessage({
        type: "SET_PRESERVE_GEO_PROMPT",
        payload: { enabled },
      });
    } catch (error: unknown) {
      console.error("Failed to set preserve-geolocation-prompt:", error);
      target.checked = !enabled;
    }
  })();
});

// Advanced worker protection is now always-on on Firefox (and a no-op
// on Chromium / Safari), so there's no toggle to wire up. The feature
// is gated by manifest-declared webRequest permissions which the user
// accepts at install time.

// Location search with debounce
let searchTimeout: ReturnType<typeof setTimeout> | undefined;

document.getElementById("locationSearch")?.addEventListener("focus", () => {
  // On mobile, scroll the search input into view above the virtual keyboard.
  // Use "center" so it sits in the visible area between the header and keyboard.
  setTimeout(() => {
    document
      .getElementById("locationSearch")
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, 300);
});

// When the virtual keyboard opens/closes on Android, the visual viewport shrinks.
// Re-scroll the focused search input into view so it isn't hidden.
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", () => {
    const searchInput = document.getElementById("locationSearch");
    if (document.activeElement === searchInput) {
      searchInput?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });
}

document.getElementById("locationSearch")?.addEventListener("input", (e: Event) => {
  clearTimeout(searchTimeout);
  const target = e.target as HTMLInputElement;
  const query = target.value.trim();

  const container = document.getElementById("searchResults");
  if (!container) return;

  if (query.length < 3) {
    clearChildren(container);
    return;
  }

  clearChildren(container);
  const loadingDiv = document.createElement("div");
  loadingDiv.className = "loading";
  const spinner = document.createElement("div");
  spinner.className = "spinner";
  loadingDiv.appendChild(spinner);
  loadingDiv.appendChild(document.createTextNode(t("search_searching") || "Searching..."));
  container.appendChild(loadingDiv);

  searchTimeout = setTimeout(() => {
    void (async () => {
      try {
        const response = (await browser.runtime.sendMessage({
          type: "GEOCODE_QUERY",
          payload: { query },
        })) as GeocodeResponse;

        displaySearchResults(response.results ?? [], (lat, lon) => {
          void setLocation(lat, lon);
        });

        // On mobile, re-scroll the search input into view after results render
        // so the keyboard doesn't end up covering it.
        const isTouchDevice = window.matchMedia("(pointer: coarse)").matches;
        if (isTouchDevice) {
          const searchInput = document.getElementById("locationSearch");
          if (searchInput && document.activeElement === searchInput) {
            requestAnimationFrame(() => {
              searchInput.scrollIntoView({ behavior: "smooth", block: "center" });
            });
          }
        }
      } catch (error: unknown) {
        console.error("Geocoding failed:", error);
        clearChildren(container);
        const errorDiv = document.createElement("div");
        errorDiv.className = "no-results";
        errorDiv.textContent = t("search_failed") || "Search failed. Please try again.";
        container.appendChild(errorDiv);
      }
    })();
  }, 300);
});

// Manual coordinates
document.getElementById("setManualCoords")?.addEventListener("click", () => {
  const latInput = document.getElementById("latitudeInput") as HTMLInputElement | null;
  const lonInput = document.getElementById("longitudeInput") as HTMLInputElement | null;

  if (!latInput || !lonInput) return;

  const lat = parseFloat(latInput.value);
  const lon = parseFloat(lonInput.value);

  if (isNaN(lat) || lat < -90 || lat > 90) {
    alert(t("coords_invalidLat") || "Invalid latitude. Must be between -90 and 90.");
    return;
  }

  if (isNaN(lon) || lon < -180 || lon > 180) {
    alert(t("coords_invalidLon") || "Invalid longitude. Must be between -180 and 180.");
    return;
  }

  void setLocation(lat, lon).then(() => {
    latInput.value = "";
    lonInput.value = "";
  });
});

// VPN Sync toggle
document.getElementById("vpnSyncToggle")?.addEventListener("change", (e: Event) => {
  const target = e.target as HTMLInputElement;
  if (target.checked) {
    activateVpnSyncMode();
  } else {
    void deactivateVpnSyncMode();
  }
});

// Tab switching: search / coordinates
document.getElementById("searchModeTab")?.addEventListener("click", () => {
  document.getElementById("searchModeTab")?.classList.add("active");
  document.getElementById("coordsModeTab")?.classList.remove("active");
  const searchMode = document.getElementById("searchMode");
  const coordsMode = document.getElementById("coordsMode");
  if (searchMode) searchMode.style.display = "block";
  if (coordsMode) coordsMode.style.display = "none";
});

document.getElementById("coordsModeTab")?.addEventListener("click", () => {
  document.getElementById("coordsModeTab")?.classList.add("active");
  document.getElementById("searchModeTab")?.classList.remove("active");
  const coordsMode = document.getElementById("coordsMode");
  const searchMode = document.getElementById("searchMode");
  if (coordsMode) coordsMode.style.display = "block";
  if (searchMode) searchMode.style.display = "none";
});

// VPN Sync / Re-sync buttons
document.getElementById("vpnSyncButton")?.addEventListener("click", () => {
  void handleVpnSync(false);
});

document.getElementById("vpnResyncButton")?.addEventListener("click", () => {
  void handleVpnSync(true);
});

// Clear location button
document.getElementById("clearLocationBtn")?.addEventListener("click", () => {
  void (async () => {
    try {
      await browser.runtime.sendMessage({ type: "CLEAR_LOCATION" });
      await loadSettings();
    } catch (error: unknown) {
      console.error("Failed to clear location:", error);
    }
  })();
});

/** Activate VPN sync mode: hide tabs and search/coords, show VPN panel, trigger sync */
function activateVpnSyncMode(): void {
  const inputModeTabs = document.getElementById("inputModeTabs");
  const searchMode = document.getElementById("searchMode");
  const coordsMode = document.getElementById("coordsMode");
  const vpnSyncMode = document.getElementById("vpnSyncMode");

  if (inputModeTabs) inputModeTabs.style.display = "none";
  if (searchMode) searchMode.style.display = "none";
  if (coordsMode) coordsMode.style.display = "none";
  if (vpnSyncMode) vpnSyncMode.style.display = "block";

  void handleVpnSync(false);
}

/** Deactivate VPN sync mode: hide VPN panel, show tabs with search as default, notify background */
async function deactivateVpnSyncMode(): Promise<void> {
  const inputModeTabs = document.getElementById("inputModeTabs");
  const searchMode = document.getElementById("searchMode");
  const coordsMode = document.getElementById("coordsMode");
  const vpnSyncMode = document.getElementById("vpnSyncMode");

  if (vpnSyncMode) vpnSyncMode.style.display = "none";
  if (inputModeTabs) inputModeTabs.style.display = "flex";
  if (searchMode) searchMode.style.display = "block";
  if (coordsMode) coordsMode.style.display = "none";

  // Reset tab active states
  document.getElementById("searchModeTab")?.classList.add("active");
  document.getElementById("coordsModeTab")?.classList.remove("active");

  try {
    await browser.runtime.sendMessage({ type: "DISABLE_VPN_SYNC" });
  } catch {
    // Best-effort
  }

  // Reset VPN panel UI state
  const statusEl = document.getElementById("vpnSyncStatus");
  const syncBtn = document.getElementById("vpnSyncButton");
  const resyncBtn = document.getElementById("vpnResyncButton");
  const errorEl = document.getElementById("vpnSyncError");
  if (statusEl) statusEl.style.display = "none";
  if (syncBtn) syncBtn.style.display = "block";
  if (resyncBtn) resyncBtn.style.display = "none";
  if (errorEl) errorEl.style.display = "none";

  // Reload settings so the location display reflects the cleared state
  await loadSettings();
}

/**
 * The popup's switchable views, mapped to the element that selects each one and
 * the panel it reveals.
 *
 * Single source of truth on purpose: this previously lived in three parallel
 * lists (a trigger map, a panel map, and a literal tuple to iterate), so adding a
 * view meant editing all three and forgetting one failed silently — the view
 * would render but never hide its siblings.
 *
 * `settings` is triggered by a gear in the header rather than a tab in the bar;
 * only the trigger element differs, so it participates here like any other view.
 */
const POPUP_VIEWS = {
  main: { trigger: "mainTab", panel: "mainView" },
  filters: { trigger: "filtersTab", panel: "filtersView" },
  details: { trigger: "detailsTab", panel: "detailsView" },
  settings: { trigger: "settingsTab", panel: "settingsView" },
} as const;

type PopupView = keyof typeof POPUP_VIEWS;

/**
 * Show one view and hide the rest, keeping each trigger's `aria-current` in sync.
 *
 * `aria-current` is the state mechanism for all four triggers, and it drives both
 * the visual styling and what assistive tech announces — there is no separate
 * `.active` class to keep in step. It's the right attribute here rather than
 * `aria-pressed`: these are one-of-N view selections, not independent toggles
 * that stay depressed. It also matters most for the Settings gear, which sits
 * outside the tab bar and so has no underline to inherit; without it, opening
 * Settings would leave every tab unstyled and read as "nothing selected".
 */
function showPopupView(view: PopupView): void {
  for (const [key, { trigger, panel }] of Object.entries(POPUP_VIEWS)) {
    const isCurrent = key === view;

    const triggerEl = document.getElementById(trigger);
    if (triggerEl) {
      // Set-or-remove rather than writing "false": an absent attribute keeps the
      // CSS selectors simple (`[aria-current]` means current) and matches how
      // assistive tech expects a non-current item to look.
      if (isCurrent) triggerEl.setAttribute("aria-current", "true");
      else triggerEl.removeAttribute("aria-current");
    }

    const panelEl = document.getElementById(panel);
    if (panelEl) panelEl.style.display = isCurrent ? "block" : "none";
  }
}

document.getElementById("mainTab")?.addEventListener("click", () => {
  showPopupView("main");
});

document.getElementById("filtersTab")?.addEventListener("click", () => {
  showPopupView("filters");
});

document.getElementById("detailsTab")?.addEventListener("click", () => {
  showPopupView("details");
});

document.getElementById("settingsTab")?.addEventListener("click", () => {
  showPopupView("settings");
});

// NOTE: the old "Advanced" accordion inside the Details tab is gone. Those
// controls now live in their own Settings tab, so collapsing them behind a
// disclosure toggle would just add a click to reach what the tab is for. The
// `#advancedContent` id is retained as the section wrapper so existing styling
// and any external references keep working.

// Debug logging toggle
document.getElementById("debugLoggingToggle")?.addEventListener("change", (e: Event) => {
  const target = e.target as HTMLInputElement;
  const enabled = target.checked;

  const verbositySelector = document.getElementById("verbositySelector");
  if (verbositySelector) {
    verbositySelector.style.display = enabled ? "block" : "none";
  }

  void (async () => {
    try {
      await browser.runtime.sendMessage({
        type: "SET_DEBUG_LOGGING",
        payload: { enabled },
      });
    } catch (error: unknown) {
      console.error("Failed to set debug logging:", error);
      target.checked = !enabled;
      if (verbositySelector) {
        verbositySelector.style.display = !enabled ? "block" : "none";
      }
    }
  })();
});

// Verbosity level dropdown
document.getElementById("verbosityLevel")?.addEventListener("change", (e: Event) => {
  const target = e.target as HTMLSelectElement;
  const level = target.value;

  void (async () => {
    try {
      await browser.runtime.sendMessage({
        type: "SET_VERBOSITY_LEVEL",
        payload: { level },
      });
    } catch (error: unknown) {
      console.error("Failed to set verbosity level:", error);
    }
  })();
});

// Theme selector
document.getElementById("themeSelect")?.addEventListener("change", (e: Event) => {
  const target = e.target as HTMLSelectElement;
  const theme = target.value as "system" | "light" | "dark";

  applyTheme(theme);

  void (async () => {
    try {
      await browser.runtime.sendMessage({
        type: "SET_THEME",
        payload: { theme },
      });
    } catch (error: unknown) {
      console.error("Failed to save theme:", error);
    }
  })();
});

// Language selector — override the popup UI language independently of the
// browser. Value "" means "follow the browser" (native browser.i18n path);
// otherwise it's a supported _locales code. Applied live and persisted.
document.getElementById("languageSelect")?.addEventListener("change", (e: Event) => {
  const value = (e.target as HTMLSelectElement).value;

  void (async () => {
    // Persist first so the reload below restores the just-picked value.
    try {
      await browser.runtime.sendMessage({
        type: "SET_UI_LANGUAGE",
        payload: { language: value },
      });
    } catch (error: unknown) {
      console.error("Failed to save UI language:", error);
    }

    // Swap the active catalog (or clear it for "System"), then re-translate the
    // static DOM and re-render dynamic strings via loadSettings().
    if (value) {
      await initI18n(resolveUiLocale(value, browserUiLanguage()));
    } else {
      resetI18nOverride();
    }
    applyI18n();
    // Keep the outbound geospoof.com links (Verify, Need help?) pointed at the
    // just-picked language's page — the effective locale mirrors the text.
    localizeWebsiteLinks(resolveUiLocale(value, browserUiLanguage()));
    await loadSettings();
  })();
});

/**
 * Populate the language picker with one option per supported locale (labelled
 * by endonym, never translated). The "System" option ships in the HTML; this
 * appends the rest from the single shared locale list. Idempotent.
 */
function populateLanguageOptions(): void {
  const select = document.getElementById("languageSelect") as HTMLSelectElement | null;
  if (!select || select.dataset.populated === "true") return;

  for (const locale of SUPPORTED_UI_LOCALES) {
    const option = document.createElement("option");
    option.value = locale.code;
    option.textContent = locale.endonym;
    select.appendChild(option);
  }
  select.dataset.populated = "true";
}

// Onboarding close
document.getElementById("closeOnboarding")?.addEventListener("click", () => {
  void closeOnboarding();
});

// "Love GeoSpoof?" review modal — open from the footer link, close via the
// "Maybe later" button, a tap on the scrim, or the Escape key. The CTA itself
// is a normal target="_blank" anchor (href set per-platform in init), so
// clicking it opens the store in a new tab; we just dismiss the modal too.
function openReviewModal(): void {
  const overlay = document.getElementById("reviewOverlay");
  if (overlay) overlay.style.display = "flex";
}

function closeReviewModal(): void {
  const overlay = document.getElementById("reviewOverlay");
  if (overlay) overlay.style.display = "none";
}

document.getElementById("reviewLink")?.addEventListener("click", (e: Event) => {
  e.preventDefault();
  openReviewModal();
});

document.getElementById("reviewModalDismiss")?.addEventListener("click", () => {
  closeReviewModal();
});

document.getElementById("reviewCtaLink")?.addEventListener("click", () => {
  closeReviewModal();
});

// Dismiss when tapping the scrim (but not the modal content itself).
document.getElementById("reviewOverlay")?.addEventListener("click", (e: Event) => {
  if (e.target === e.currentTarget) closeReviewModal();
});

// Escape closes the review modal.
document.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape") closeReviewModal();
});

// VPN Sync info tooltip — tap to toggle on mobile, click on desktop
document.getElementById("vpnSyncInfo")?.addEventListener("click", (e: Event) => {
  e.preventDefault();
  e.stopPropagation();
  const tooltip = document.getElementById("vpnSyncTooltip");
  tooltip?.classList.toggle("visible");
});

// Preserve-permission-prompts info tooltip
document.getElementById("preserveGeoPromptInfo")?.addEventListener("click", (e: Event) => {
  e.preventDefault();
  e.stopPropagation();
  const tooltip = document.getElementById("preserveGeoPromptTooltip");
  tooltip?.classList.toggle("visible");
});

// Dismiss the preserve-prompt tooltip when tapping elsewhere
document.addEventListener("click", (e: Event) => {
  const tooltip = document.getElementById("preserveGeoPromptTooltip");
  const infoBtn = document.getElementById("preserveGeoPromptInfo");
  if (tooltip && e.target !== infoBtn && !infoBtn?.contains(e.target as Node)) {
    tooltip.classList.remove("visible");
  }
});

// Dismiss tooltip when tapping elsewhere
document.addEventListener("click", (e: Event) => {
  const tooltip = document.getElementById("vpnSyncTooltip");
  const infoBtn = document.getElementById("vpnSyncInfo");
  if (tooltip && e.target !== infoBtn && !infoBtn?.contains(e.target as Node)) {
    tooltip.classList.remove("visible");
  }
});

// Instant timezone protection info tooltip (Firefox-only row)
document.getElementById("earlyTzInfo")?.addEventListener("click", (e: Event) => {
  e.preventDefault();
  e.stopPropagation();
  const tooltip = document.getElementById("earlyTzTooltip");
  tooltip?.classList.toggle("visible");
});

// Dismiss the early-tz tooltip when tapping elsewhere
document.addEventListener("click", (e: Event) => {
  const tooltip = document.getElementById("earlyTzTooltip");
  const infoBtn = document.getElementById("earlyTzInfo");
  if (tooltip && e.target !== infoBtn && !infoBtn?.contains(e.target as Node)) {
    tooltip.classList.remove("visible");
  }
});

// Browser-level spoofing info tooltip (Chrome-only row)
document.getElementById("debuggerModeInfo")?.addEventListener("click", (e: Event) => {
  e.preventDefault();
  e.stopPropagation();
  const tooltip = document.getElementById("debuggerModeTooltip");
  tooltip?.classList.toggle("visible");
});

// Dismiss the debugger-mode tooltip when tapping elsewhere
document.addEventListener("click", (e: Event) => {
  const tooltip = document.getElementById("debuggerModeTooltip");
  const infoBtn = document.getElementById("debuggerModeInfo");
  if (tooltip && e.target !== infoBtn && !infoBtn?.contains(e.target as Node)) {
    tooltip.classList.remove("visible");
  }
});

// Initialize
document.addEventListener("DOMContentLoaded", () => {
  document.body.classList.add("loaded");

  // Translate all [data-i18n*] nodes once the DOM is parsed. Happens
  // before loadSettings() so any text we later overwrite dynamically
  // inherits the localized copy rather than the English fallback. This first
  // pass uses the native browser-UI-locale path; if the user has a stored
  // language override, initPopupSettings() re-applies it below.
  applyI18n();

  // Localize the outbound geospoof.com links (Verify, Need help?) to match this
  // first, browser-UI-locale pass. With no stored override this is the final
  // locale; initPopupSettings() re-runs it below when an override is set
  // (idempotent — it recomputes from the stashed English href).
  localizeWebsiteLinks(resolveUiLocale(undefined, browserUiLanguage()));

  // Fill the Advanced-section language picker from the shared locale list.
  populateLanguageOptions();

  // Wire the Firefox-only "Instant timezone protection" toggle (requests the
  // optional userScripts permission). Compiles out / no-ops elsewhere.
  wireEarlyProtectionToggle();

  // Wire the Chrome-only "Browser-level spoofing" (chrome.debugger) toggle.
  // Compiles out / no-ops elsewhere.
  wireDebuggerModeToggle();

  // Wire the accuracy control (Advanced accordion). State is restored later in
  // loadSettings() from the stored accuracySetting.
  initAccuracyControl();

  // Wire the location-precision control (Advanced accordion). State is restored
  // later in loadSettings() from the stored locationPrecision.
  initPrecisionControl();
  // And the "Pick a new point" cadence control under it (restored from the
  // stored precisionCadence).
  initPrecisionCadenceControl();

  // Wire the Reported Language control (Advanced accordion) and populate its
  // typeahead suggestions. State is restored later in loadSettings() from the
  // stored localeSpoofing.
  initLocaleControl();

  // Wire convenient coordinate pasting: pasting a "lat, lon" pair, a DMS string,
  // or a geohash into the manual-coordinates inputs parses it and applies the
  // location. Permission-free (uses the paste event, not clipboard.readText()).
  wireCoordinatePaste((latitude, longitude) => {
    void setLocation(latitude, longitude);
  });

  const versionLabel = document.getElementById("versionLabel");
  if (versionLabel) {
    const manifest = browser.runtime.getManifest();
    versionLabel.textContent = `v${manifest.version}`;
  }

  // Hide the coffee link on Safari (App Store guidelines prohibit external
  // payment/donation links in distributed apps).
  if (__SAFARI__) {
    const coffeeRow = document.getElementById("coffeeRow");
    if (coffeeRow) coffeeRow.style.display = "none";
  }

  // Point the "Love GeoSpoof?" modal CTA at the current platform's store
  // review flow. Reviews are our biggest growth lever, so the footer link
  // opens a short personal ask (see the click handlers above) and this button
  // deep-links straight to the right store. The HTML ships the Chromium URL
  // as the static default; override it for Safari/Firefox.
  const reviewCta = document.getElementById("reviewCtaLink") as HTMLAnchorElement | null;
  if (reviewCta) {
    if (__SAFARI__) {
      // App Store: opens the write-a-review composer directly. pt is our
      // provider token; ct=ext-popup tags this as the in-popup review prompt
      // so it shows up under Campaigns in App Store Connect → App Analytics.
      reviewCta.href =
        "https://apps.apple.com/app/apple-store/id6765719745?action=write-review&pt=128299974&ct=ext-popup";
    } else if (__FIREFOX__) {
      reviewCta.href =
        "https://addons.mozilla.org/firefox/addon/geo-spoof/reviews/?utm_source=extension&utm_medium=popup&utm_campaign=ext-popup";
    } else {
      reviewCta.href =
        "https://chromewebstore.google.com/detail/geospoof/dgdbdodafgaeifgajaajohkjjgobcgje/reviews?utm_source=extension&utm_medium=popup&utm_campaign=ext-popup";
    }
  }

  // Adjust the modal's first line per platform. The default copy speaks to the
  // desktop builds (Chromium, Firefox, and Safari on macOS); the iOS build is
  // freemium and gets its own privacy-focused variant. The Safari build ships
  // to both iOS and macOS from one bundle, so we detect iOS at runtime via the
  // user agent.
  const isIOS = __SAFARI__ && /iPhone|iPad|iPod/.test(navigator.userAgent);
  if (isIOS) {
    const body1 = document.getElementById("reviewModalBody1");
    const iosCopy = t("review_modal_body1_ios");
    if (body1 && iosCopy) body1.textContent = iosCopy;
  }

  // Footer ecosystem cross-link. Shown on every platform: the App Store is
  // where GeoSpoof Pro is bought, and Pro is what unlocks device GPS no matter
  // which desktop build drives it, so the link is relevant even to someone on
  // Windows or Linux. Its label names only the iPhone and states the outcome,
  // so it reads correctly on every host OS and needs no runtime narrowing —
  // see the rationale on the anchor in popup.html. The Proton VPN affiliate
  // slot (vpnPromoLink) stays hidden.
  void initPopupSettings();
});

/**
 * Fetch settings once, apply any stored UI-language override (re-translating
 * the static DOM into the chosen language), then hand the same settings to
 * loadSettings() so it renders dynamic strings in that language without a
 * second GET_SETTINGS round-trip.
 *
 * The common case (no override) skips the catalog fetch entirely: the earlier
 * synchronous applyI18n() already rendered the browser UI locale, so there's no
 * extra work and no flash.
 */
async function initPopupSettings(): Promise<void> {
  const settings = await requestSettings();

  if (settings.uiLanguage) {
    await initI18n(resolveUiLocale(settings.uiLanguage, browserUiLanguage()));
    applyI18n();
    // Re-point the outbound links at the overridden language (the initial
    // DOMContentLoaded pass used the browser UI locale). Idempotent.
    localizeWebsiteLinks(resolveUiLocale(settings.uiLanguage, browserUiLanguage()));
  }

  await loadSettings(settings);
}
