/**
 * One queue for every write of `settings.siteLocations`: SAVE_SITE_LOCATION,
 * REMOVE_SITE_LOCATION, and the Safari bridge's adoption (step 9). Each runs
 * its final load, checks, write, and delivery as one job, so two overlapping
 * changes can't both read the same list and have the later write erase the
 * earlier one. Lookups that wait on the network stay outside the queue and
 * are re-checked inside it.
 */

let queue: Promise<unknown> = Promise.resolve();
let localEdits = 0;

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

/** Record a written save or remove. Call inside the job, after the write. */
export function noteLocalSiteLocationEdit(): void {
  localEdits += 1;
}
