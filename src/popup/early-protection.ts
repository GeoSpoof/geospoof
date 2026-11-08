/**
 * "Instant timezone protection" opt-in (Firefox only).
 *
 * Closing the synchronous-timezone cold-start race (a page reading
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` / `new Date()` in its very
 * first `<script>`, before our async settings arrive) requires registering a
 * MAIN-world `userScripts` document_start script from the background — see
 * `background/bootstrap-register.ts`. On Firefox the `userScripts` API is an
 * *optional-only* permission: it is never granted at install time and must be
 * requested at runtime from a genuine user gesture via `permissions.request()`.
 *
 * This module wires the Advanced-section toggle that drives that grant:
 *   - checking it calls `permissions.request({ permissions: ["userScripts"] })`
 *     (optional-only perms must be requested alone) inside the click/change
 *     handler so Firefox accepts it as a user action;
 *   - unchecking it calls `permissions.remove(...)`.
 * The background's `permissions.onAdded` / `onRemoved` listeners then register
 * or tear down the bootstrap script. The checkbox simply reflects whether the
 * permission is currently held.
 *
 * Everything is gated on `__FIREFOX__` and feature-detected, so it compiles out
 * and no-ops elsewhere.
 */

import { revealSettingsGroup } from "./settings-rows";

const USER_SCRIPTS_PERMISSION: { permissions: string[] } = { permissions: ["userScripts"] };

/** Narrow access to the optional `browser.permissions` namespace. */
function permissionsApi(): {
  contains: (p: { permissions: string[] }) => Promise<boolean>;
  request: (p: { permissions: string[] }) => Promise<boolean>;
  remove: (p: { permissions: string[] }) => Promise<boolean>;
} | null {
  type PermsApi = {
    contains: (p: { permissions: string[] }) => Promise<boolean>;
    request: (p: { permissions: string[] }) => Promise<boolean>;
    remove: (p: { permissions: string[] }) => Promise<boolean>;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
  const api = (browser as any).permissions as PermsApi | undefined;
  if (
    api &&
    typeof api.contains === "function" &&
    typeof api.request === "function" &&
    typeof api.remove === "function"
  ) {
    return api;
  }
  return null;
}

/**
 * Show the toggle (Firefox only) and sync its checked state to whether the
 * `userScripts` permission is currently granted. Safe to call on every popup
 * load; no-ops on non-Firefox builds.
 */
export async function reflectEarlyProtectionState(): Promise<void> {
  if (!__FIREFOX__) return;
  const row = document.getElementById("earlyTzRow");
  const toggle = document.getElementById("earlyTzToggle") as HTMLInputElement | null;
  if (!row || !toggle) return;

  const api = permissionsApi();
  if (!api) {
    // userScripts unsupported on this Firefox version — keep the row hidden.
    return;
  }

  row.style.display = "";
  revealSettingsGroup("settingsAdvancedGroup");
  try {
    toggle.checked = await api.contains(USER_SCRIPTS_PERMISSION);
  } catch {
    toggle.checked = false;
  }
}

/**
 * Attach the change handler that requests/removes the `userScripts` permission.
 * The `permissions.request()` call is made synchronously inside the handler so
 * it counts as a user gesture in Firefox. No-ops on non-Firefox builds.
 */
export function wireEarlyProtectionToggle(): void {
  if (!__FIREFOX__) return;
  const toggle = document.getElementById("earlyTzToggle") as HTMLInputElement | null;
  if (!toggle) return;

  toggle.addEventListener("change", (e: Event) => {
    const target = e.target as HTMLInputElement;
    const wantOn = target.checked;
    const api = permissionsApi();
    if (!api) {
      target.checked = false;
      return;
    }

    // Call request()/remove() synchronously (no await before it) so Firefox
    // treats it as happening within the user input handler.
    const op = wantOn ? api.request(USER_SCRIPTS_PERMISSION) : api.remove(USER_SCRIPTS_PERMISSION);

    op.then(
      (ok: boolean) => {
        // For a grant request, `ok` is whether it was granted (false if the
        // user dismissed). For a remove, `ok` is whether it was removed. Either
        // way, reflect the real resulting state rather than the optimistic one.
        target.checked = wantOn ? ok : !ok;
      },
      (error: unknown) => {
        console.error("Failed to update userScripts permission:", error);
        target.checked = !wantOn;
      }
    );
  });
}
