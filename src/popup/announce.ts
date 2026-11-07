/**
 * The popup's one polite live region for confirmations, `#siteLocationAnnouncer`.
 *
 * It sits outside every view, so it speaks from any tab or Filters screen. The
 * region is cleared first and the text set a moment later, so the same message
 * repeated is spoken again; a newer message replaces one still pending.
 */

/** Long enough for screen readers to register the cleared region first. */
const ANNOUNCE_DELAY_MS = 100;

let announceTimer: ReturnType<typeof setTimeout> | undefined;

/** Speak `text` through #siteLocationAnnouncer. */
export function announce(text: string): void {
  const region = document.getElementById("siteLocationAnnouncer");
  if (!region) return;
  clearTimeout(announceTimer);
  region.textContent = "";
  announceTimer = setTimeout(() => {
    region.textContent = text;
  }, ANNOUNCE_DELAY_MS);
}

/**
 * A status value as it should be spoken. Screen readers at their default
 * punctuation level usually skip "·", so "Empty · Off on every site" is read
 * as "Empty, Off on every site" instead.
 */
export function spokenValue(text: string): string {
  return text.replaceAll(" · ", ", ");
}

/** Test hook: drop a pending announcement. */
export function __resetAnnounceForTest(): void {
  clearTimeout(announceTimer);
  announceTimer = undefined;
}
