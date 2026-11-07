/**
 * Where the reload hint shows after a change made from this popup (open pages
 * keep old values until reloaded): under the Main line ("line"), on the
 * Per-site locations screen ("perSite"), in the open editor ("editor"), or on
 * the This site card ("card"). Module state only, so it lasts for the popup
 * session. No imports, so every writer can set it.
 */

export type ReloadHintHost = "line" | "perSite" | "editor" | "card";

let host: ReloadHintHost | null = null;

export function getReloadHintHost(): ReloadHintHost | null {
  return host;
}

export function setReloadHintHost(next: ReloadHintHost | null): void {
  host = next;
}

/** Test hook: no hint shows. */
export function __resetReloadHintForTest(): void {
  host = null;
}
