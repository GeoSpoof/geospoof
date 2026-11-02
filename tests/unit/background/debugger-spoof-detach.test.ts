/**
 * When the user cancels Chrome's debugging bar, the tab's engine override may
 * or may not revert, so its payload is sent again and every frame re-checks
 * whether its engine still reports the page's zone. Nothing re-attaches.
 */
import { describe, test, expect, vi } from "vitest";
import { handleDebuggerDetach } from "@/background/debugger-spoof";

describe("handleDebuggerDetach", () => {
  test("a cancelled session re-sends that tab's payload", async () => {
    const resend = vi.fn().mockResolvedValue(undefined);
    await handleDebuggerDetach("canceled_by_user", 7, resend);
    expect(resend).toHaveBeenCalledExactlyOnceWith(7);
  });

  test("a closed target sends nothing", async () => {
    const resend = vi.fn().mockResolvedValue(undefined);
    await handleDebuggerDetach("target_closed", 7, resend);
    expect(resend).not.toHaveBeenCalled();
  });

  test("no tab id sends nothing", async () => {
    const resend = vi.fn().mockResolvedValue(undefined);
    await handleDebuggerDetach("canceled_by_user", undefined, resend);
    expect(resend).not.toHaveBeenCalled();
  });

  test("a failed re-send doesn't throw", async () => {
    const resend = vi.fn().mockRejectedValue(new Error("No tab with id: 7"));
    await expect(handleDebuggerDetach("canceled_by_user", 7, resend)).resolves.toBeUndefined();
  });
});
