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
 * request order. Each save and remove is stamped when it arrives, and a save
 * whose entry was already written by a later request skips its write, so the
 * later user action wins.
 */

let queue: Promise<unknown> = Promise.resolve();
let localEdits = 0;
let arrivals = 0;
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

/** Stamp a save or remove when its request arrives, before any await. */
export function stampSiteLocationRequest(): number {
  arrivals += 1;
  return arrivals;
}

/**
 * Whether a request that arrived after the one stamped `stamp` has already
 * written entry `id`. Call inside the job, before writing.
 */
export function isSiteLocationEntrySuperseded(id: string, stamp: number): boolean {
  return (newestEntryWrite.get(id) ?? 0) > stamp;
}
