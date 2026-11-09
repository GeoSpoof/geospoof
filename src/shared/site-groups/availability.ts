/**
 * Whether this build may CREATE exact (`=host`), site group (`geosite:`) and
 * list-from-a-link (`list:`) entries.
 *
 * True on every browser. Safari offers the forms too, gated by
 * `proFeaturesBlocked` like the rest of Filters, because the GeoSpoof app
 * parses, round-trips, displays and matches them since geospoof-ios PR 1
 * (#37): it no longer drops entries it doesn't recognize, so a token added in
 * Safari's popup survives the app's next sync.
 *
 * `assets/site-groups/safari-forms.json` must ship exactly while this is true
 * on Safari: the app offers the new forms, and downloads lists from links,
 * only when its embedded extension contains that file. Turning this off for
 * Safari again means deleting the file in the same change.
 *
 * Where it's false, stored or bridged tokens still validate and round-trip
 * unchanged, so the gate is never destructive; it only hides the kinds in the
 * popup, rejects them in the add and save handlers, and keeps the refresh
 * alarm and its network requests off.
 *
 * A function in its own module so tests can `vi.mock` it.
 */
export function siteGroupsAvailable(): boolean {
  return true;
}
