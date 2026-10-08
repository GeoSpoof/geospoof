/**
 * Property-Based Tests for Permissions Query Override
 * Feature: permissions-query-spoofing
 *
 * Property 1: Geolocation permission query returns "granted" when spoofing is enabled
 * Property 2: Non-geolocation permission queries delegate to original when spoofing is enabled
 * Property 3: All permission queries delegate to original when spoofing is disabled
 * Property 4: Spoofed PermissionStatus object fidelity
 * Property 5: Spoofing state toggle immediately changes permissions behavior
 * Property 6: Invalid descriptors delegate to original
 */

import fc from "fast-check";
import { setupContentScript } from "../helpers/content.test.helper";

describe("Permissions Query Override Properties", () => {
  /**
   * Feature: permissions-query-spoofing, Property 1: Geolocation permission query returns "granted" when spoofing is enabled
   *
   * For any call to navigator.permissions.query({name: "geolocation"}) while
   * spoofing is enabled, the resolved object's state equals "granted".
   *
   * Validates: Requirements 2.1, 3.1
   */
  test("Property 1: Geolocation permission query returns 'granted' when spoofing enabled", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          latitude: fc.double({ min: -90, max: 90, noNaN: true }),
          longitude: fc.double({ min: -180, max: 180, noNaN: true }),
          accuracy: fc.double({ min: 1, max: 100, noNaN: true }),
        }),
        async (spoofedLocation) => {
          const contentScript = setupContentScript({
            enabled: true,
            location: spoofedLocation,
            timezone: null,
          });

          const result = await contentScript.navigator.permissions.query({
            name: "geolocation",
          });

          expect(result.state).toBe("granted");
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Feature: permissions-query-spoofing, Property 2: Non-geolocation permission queries delegate to original when spoofing is enabled
   *
   * For any permission name string that is not "geolocation", when spoofing is
   * enabled, the override delegates to the original method.
   *
   * Validates: Requirements 2.2
   */
  test("Property 2: Non-geolocation queries delegate to original when spoofing enabled", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ unit: "binary-ascii", minLength: 1 }).filter((s) => s !== "geolocation"),
        async (permissionName) => {
          const contentScript = setupContentScript({
            enabled: true,
            location: { latitude: 40, longitude: -74, accuracy: 10 },
            timezone: null,
          });

          await contentScript.navigator.permissions.query({
            name: permissionName,
          });

          expect(contentScript.originals.permissionsQuery).toHaveBeenCalledWith({
            name: permissionName,
          });
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Feature: permissions-query-spoofing, Property 3: All permission queries delegate to original when spoofing is disabled
   *
   * For any permission descriptor (including {name: "geolocation"}), when
   * spoofing is disabled, the override delegates to the original method.
   *
   * Validates: Requirements 2.3
   */
  test("Property 3: All queries delegate to original when spoofing disabled", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constant("geolocation"),
          fc.constant("notifications"),
          fc.constant("camera"),
          fc.constant("microphone"),
          fc.string({ unit: "binary-ascii", minLength: 1 })
        ),
        async (permissionName) => {
          const contentScript = setupContentScript({
            enabled: false,
            location: null,
            timezone: null,
          });

          await contentScript.navigator.permissions.query({
            name: permissionName,
          });

          expect(contentScript.originals.permissionsQuery).toHaveBeenCalledWith({
            name: permissionName,
          });
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Feature: permissions-query-spoofing, Property 4: Spoofed PermissionStatus object fidelity
   *
   * For any spoofed PermissionStatus: `state` equals "granted" and is read-only
   * (assigning a different value does not change it), `onchange` is initialized
   * to null, and `addEventListener`/`removeEventListener` are callable.
   *
   * Validates: Requirements 3.1, 3.2, 3.3, 3.4
   */
  test("Property 4: Spoofed PermissionStatus object fidelity", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.constant("denied"), fc.constant("prompt"), fc.string()),
        async (assignValue) => {
          const contentScript = setupContentScript({
            enabled: true,
            location: { latitude: 40, longitude: -74, accuracy: 10 },
            timezone: null,
          });

          const result = await contentScript.navigator.permissions.query({
            name: "geolocation",
          });

          // state equals "granted"
          expect(result.state).toBe("granted");

          // state is read-only — assigning does not change it
          try {
            (result as unknown as Record<string, unknown>).state = assignValue;
          } catch {
            // assignment may throw in strict mode; that's fine
          }
          expect(result.state).toBe("granted");

          // onchange initialized to null
          expect(result.onchange).toBeNull();

          // addEventListener and removeEventListener are callable
          expect(typeof result.addEventListener).toBe("function");
          expect(typeof result.removeEventListener).toBe("function");

          // Verify they don't throw when called
          const noop = () => {};
          result.addEventListener("change", noop);
          result.removeEventListener("change", noop);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Feature: permissions-query-spoofing, Property 5: Spoofing state toggle immediately changes permissions behavior
   *
   * For any initial spoofing state, toggling from disabled to enabled causes the
   * next geolocation query to return state: "granted", and toggling back causes
   * delegation to the original — without page reload.
   *
   * Validates: Requirements 5.1, 5.2
   */
  test("Property 5: Spoofing state toggle immediately changes behavior", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          latitude: fc.double({ min: -90, max: 90, noNaN: true }),
          longitude: fc.double({ min: -180, max: 180, noNaN: true }),
          accuracy: fc.double({ min: 1, max: 100, noNaN: true }),
        }),
        async (location) => {
          // Start with spoofing disabled
          const contentScript = setupContentScript({
            enabled: false,
            location: null,
            timezone: null,
          });

          // Query while disabled — should delegate to original
          await contentScript.navigator.permissions.query({ name: "geolocation" });
          expect(contentScript.originals.permissionsQuery).toHaveBeenCalledWith({
            name: "geolocation",
          });

          contentScript.originals.permissionsQuery.mockClear();

          // Toggle to enabled
          contentScript.updateSettings({ enabled: true, location });

          // Query while enabled — should return "granted"
          const enabledResult = await contentScript.navigator.permissions.query({
            name: "geolocation",
          });
          expect(enabledResult.state).toBe("granted");
          // Should NOT have delegated to original
          expect(contentScript.originals.permissionsQuery).not.toHaveBeenCalled();

          // Toggle back to disabled
          contentScript.updateSettings({ enabled: false });

          // Query while disabled again — should delegate to original
          await contentScript.navigator.permissions.query({ name: "geolocation" });
          expect(contentScript.originals.permissionsQuery).toHaveBeenCalledWith({
            name: "geolocation",
          });
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Feature: permissions-query-spoofing, Property 6: Invalid descriptors delegate to original
   *
   * For any invalid or malformed descriptor (null, undefined, missing name,
   * non-object), the override delegates to the original method regardless of
   * spoofing state.
   *
   * Validates: Requirements 4.3
   */
  test("Property 6: Invalid descriptors delegate to original", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.constant({}),
          fc.constant({ name: 123 })
        ),
        fc.boolean(),
        async (invalidDescriptor, spoofingOn) => {
          const contentScript = setupContentScript({
            enabled: spoofingOn,
            location: spoofingOn ? { latitude: 40, longitude: -74, accuracy: 10 } : null,
            timezone: null,
          });

          /* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any */
          await contentScript.navigator.permissions.query(invalidDescriptor as any);

          expect(contentScript.originals.permissionsQuery).toHaveBeenCalledWith(invalidDescriptor);
          /* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any */
        }
      ),
      { numRuns: 100 }
    );
  });
});
