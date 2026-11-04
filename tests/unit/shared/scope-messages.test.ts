import { describe, it, expect, expectTypeOf } from "vitest";
import type {
  SetScopeModePayload,
  ScopeSitePayload,
  ScopeSuccessResponse,
  ScopeErrorResponse,
  ScopeResponse,
  UpdateSettingsPayload,
  MessageType,
} from "@/shared/types/messages";
import type { ScopeMode } from "@/shared/types/settings";

describe("site-scoping message types", () => {
  it("SetScopeModePayload carries a ScopeMode", () => {
    const payload: SetScopeModePayload = { scopeMode: "allowlist" };
    expect(payload.scopeMode).toBe("allowlist");
    expectTypeOf<SetScopeModePayload["scopeMode"]>().toEqualTypeOf<ScopeMode>();
  });

  it("ScopeSitePayload constrains list to allowlist/denylist", () => {
    const allow: ScopeSitePayload = { list: "allowlist", pattern: "example.com" };
    const deny: ScopeSitePayload = { list: "denylist", pattern: "example.org" };
    expect(allow.list).toBe("allowlist");
    expect(deny.list).toBe("denylist");
    expectTypeOf<ScopeSitePayload["list"]>().toEqualTypeOf<"allowlist" | "denylist">();
    expectTypeOf<ScopeSitePayload["pattern"]>().toEqualTypeOf<string>();
  });

  it("ScopeSuccessResponse has success: true", () => {
    const ok: ScopeSuccessResponse = { success: true };
    expect(ok.success).toBe(true);
    expectTypeOf<ScopeSuccessResponse["success"]>().toEqualTypeOf<true>();
  });

  it("ScopeErrorResponse constrains error codes", () => {
    const invalid: ScopeErrorResponse = { error: "INVALID_PATTERN" };
    const storage: ScopeErrorResponse = { error: "STORAGE_ERROR" };
    expect(invalid.error).toBe("INVALID_PATTERN");
    expect(storage.error).toBe("STORAGE_ERROR");
    expectTypeOf<ScopeErrorResponse["error"]>().toEqualTypeOf<
      | "INVALID_PATTERN"
      | "STORAGE_ERROR"
      | "UNKNOWN_GROUP"
      | "EMPTY_GROUP"
      | "LINK_FAILED"
      | "LINK_EMPTY"
      | "LINK_TOO_LARGE"
      | "STORAGE_FULL"
    >();
  });

  it("ScopeResponse is the union of success and error responses", () => {
    const responses: ScopeResponse[] = [{ success: true }, { error: "STORAGE_ERROR" }];
    expect(responses).toHaveLength(2);
    expectTypeOf<ScopeResponse>().toEqualTypeOf<ScopeSuccessResponse | ScopeErrorResponse>();
  });

  it("new scope message types are part of the MessageType union", () => {
    const types: MessageType[] = ["SET_SCOPE_MODE", "ADD_SCOPE_SITE", "REMOVE_SCOPE_SITE"];
    expect(types).toEqual(["SET_SCOPE_MODE", "ADD_SCOPE_SITE", "REMOVE_SCOPE_SITE"]);
    expectTypeOf<"SET_SCOPE_MODE">().toMatchTypeOf<MessageType>();
    expectTypeOf<"ADD_SCOPE_SITE">().toMatchTypeOf<MessageType>();
    expectTypeOf<"REMOVE_SCOPE_SITE">().toMatchTypeOf<MessageType>();
  });

  it("UpdateSettingsPayload has no allowlist/denylist keys", () => {
    type UpdateKeys = keyof UpdateSettingsPayload;
    // If a list key ever leaks into UpdateSettingsPayload these assignments fail to compile.
    expectTypeOf<"allowlist">().not.toMatchTypeOf<UpdateKeys>();
    expectTypeOf<"denylist">().not.toMatchTypeOf<UpdateKeys>();
    expectTypeOf<"scopeMode">().not.toMatchTypeOf<UpdateKeys>();

    const expectedKeys: UpdateKeys[] = [
      "enabled",
      "location",
      "timezone",
      "debugLogging",
      "verbosityLevel",
      "webrtcProtection",
    ];
    const runtimeKeys = new Set<string>(expectedKeys);
    expect(runtimeKeys.has("allowlist")).toBe(false);
    expect(runtimeKeys.has("denylist")).toBe(false);
  });
});
