/**
 * One queue for every write of `settings.siteLocations`: SAVE_SITE_LOCATION,
 * REMOVE_SITE_LOCATION, and the Safari bridge's adoption (step 9). Each runs
 * its final load, checks, write, and delivery as one job, so two overlapping
 * changes can't both read the same list and have the later write erase the
 * earlier one. Lookups that wait on the network stay outside the queue and
 * are re-checked inside it, so a stalled lookup never holds up a remove or an
 * adoption.
 *
 * Because a save joins the queue only after its lookups, queue order isn't
 * request order. Each save and remove is stamped when it arrives, with its
 * arrival time in ms, and a save whose entry was already written by a later
 * request skips its write, so the later user action wins. An app adoption
 * stamps the entries it changes with the app's action time, so a popup save
 * that arrived before the app's action yields to it too.
 */

import type { SiteLocation } from "@/shared/types/settings";

let queue: Promise<unknown> = Promise.resolve();
let localEdits = 0;
let lastStamp = 0;
/** Per entry id, the stamp of the newest request that wrote it. */
const newestEntryWrite = new Map<string, number>();

/** Run `job` after every job queued before it. A failed job doesn't wedge the queue. */
export function runSiteLocationJob<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job);
  queue = run.catch(() => undefined);
  return run;
}

/**
 * How many saves and removes this background has written. The bridge reads it
 * before its newer-than check and again inside its job: a change means a local
 * edit landed after the check, so the edit is newer than the app's snapshot
 * and the snapshot's list is not adopted.
 */
export function localSiteLocationEdits(): number {
  return localEdits;
}

/**
 * Record a written save or remove of entry `id`, by the request stamped
 * `stamp`. Call inside the job, after the write.
 */
export function noteLocalSiteLocationEdit(id: string, stamp: number): void {
  localEdits += 1;
  newestEntryWrite.set(id, Math.max(newestEntryWrite.get(id) ?? 0, stamp));
}

/**
 * Record that an app snapshot whose action time is `atMs` changed or removed
 * entry `id`. Call inside the job, after the write.
 */
export function noteAdoptedSiteLocationChange(id: string, atMs: number): void {
  newestEntryWrite.set(id, Math.max(newestEntryWrite.get(id) ?? 0, atMs));
  // Every request that arrives after this adoption is newer than it, even if
  // the clock steps back.
  lastStamp = Math.max(lastStamp, Math.ceil(atMs));
}

/**
 * Stamp a save or remove when its request arrives, before any await: its
 * arrival time in ms, above every earlier stamp and every recorded adoption.
 */
export function stampSiteLocationRequest(): number {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return lastStamp;
}

/**
 * Whether a request that arrived after the one stamped `stamp`, or an app
 * action newer than it, has already written entry `id`. Call inside the job,
 * before writing.
 */
export function isSiteLocationEntrySuperseded(id: string, stamp: number): boolean {
  return (newestEntryWrite.get(id) ?? 0) > stamp;
}

/**
 * What counts as a user change to an entry. The zone's offsets are derived
 * from its id (and recomputed with today's date for bridged bare-id or
 * offset-less zones), and location.accuracy is derived from the global
 * accuracy setting at save time (or defaulted by validation when the app
 * drops it), so a difference in those alone isn't a change anyone made.
 */
function siteLocationChangeKey(e: SiteLocation): string {
  return JSON.stringify({
    ...e,
    location: { latitude: e.location.latitude, longitude: e.location.longitude },
    timezone: e.timezone.identifier,
  });
}

/** Every id in either list whose change key differs between them: added, changed, or removed. */
export function changedSiteLocationIds(
  before: readonly SiteLocation[],
  after: readonly SiteLocation[]
): string[] {
  const b = new Map(before.map((e) => [e.id, siteLocationChangeKey(e)]));
  const a = new Map(after.map((e) => [e.id, siteLocationChangeKey(e)]));
  return [...new Set([...b.keys(), ...a.keys()])].filter((id) => b.get(id) !== a.get(id));
}
