/**
 * When a tab's debug session ends and the tab stays open (the user cancelled
 * Chrome's debugging bar, or another extension's frame made Chrome end it with
 * `target_closed`), the tab's engine override may or may not revert, so its
 * payload is sent again and every frame re-checks whether its engine still
 * reports the page's zone. Nothing re-attaches. `resend` is what tells a
 * closed tab from an open one (`resendTabPayload` sends nothing when
 * `tabs.get` fails).
 */
import { describe, test, expect, vi } from "vitest";
import { handleDebuggerDetach } from "@/background/debugger-spoof";

describe("handleDebuggerDetach", () => {
  test("a session that ended re-sends that tab's payload", async () => {
    const resend = vi.fn().mockResolvedValue(undefined);
    await handleDebuggerDetach(7, resend);
    expect(resend).toHaveBeenCalledExactlyOnceWith(7);
  });

  test("no tab id sends nothing", async () => {
    const resend = vi.fn().mockResolvedValue(undefined);
    await handleDebuggerDetach(undefined, resend);
    expect(resend).not.toHaveBeenCalled();
  });

  test("a failed re-send doesn't throw", async () => {
    const resend = vi.fn().mockRejectedValue(new Error("No tab with id: 7"));
    await expect(handleDebuggerDetach(7, resend)).resolves.toBeUndefined();
  });
});
