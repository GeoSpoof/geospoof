/**
 * Whether this build may CREATE exact (`=host`), site group (`geosite:`) and
 * list-from-a-link (`list:`) entries.
 *
 * False on Safari until geospoof-ios parses and round-trips those forms: an
 * older Swift parser drops entries it doesn't recognize, so letting the popup
 * add them would let the app wipe them on the next sync. Stored or bridged
 * tokens still validate and round-trip unchanged, so the gate is never
 * destructive; it only hides the kinds in the popup, rejects them in the add
 * and save handlers, and keeps the refresh alarm and its network requests off.
 *
 * Flip to `return true` in this repo only after geospoof-ios `main` supports
 * the forms: app builds take the tip of this repo's `main`, with nothing
 * pinning it.
 *
 * A function in its own module so tests can `vi.mock` it.
 */
export function siteGroupsAvailable(): boolean {
  return !__SAFARI__;
}
