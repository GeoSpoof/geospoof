import { describe, expect, it } from "vitest";

import {
  ACTIVATION_EXTENSION_SOURCE,
  ACTIVATION_PAGE_SOURCE,
  ACTIVATION_PING_EVENT,
  ACTIVATION_PING_TYPE,
  ACTIVATION_PROTOCOL_VERSION,
  ACTIVATION_READY_EVENT,
  ACTIVATION_READY_TYPE,
  type ActivationPingMessage,
} from "@/shared/activation-protocol";
import {
  activationResponseFor,
  installActivationResponder,
  isActivationPage,
  type ActivationMessageContext,
} from "@/content/activation-responder";
const NONCE = "7fd3662d-f447-4a73-bc04-3f3fceae5762";

function ping(overrides: Partial<ActivationPingMessage> = {}): ActivationPingMessage {
  return {
    source: ACTIVATION_PAGE_SOURCE,
    type: ACTIVATION_PING_TYPE,
    protocolVersion: ACTIVATION_PROTOCOL_VERSION,
    nonce: NONCE,
    ...overrides,
  };
}

function context(overrides: Partial<ActivationMessageContext> = {}): ActivationMessageContext {
  return {
    pageOrigin: "https://www.geospoof.com",
    pagePathname: "/activate",
    isTopFrame: true,
    eventOrigin: "https://www.geospoof.com",
    eventSourceIsWindow: true,
    data: ping(),
    ready: true,
    ...overrides,
  };
}

describe("activation page boundary", () => {
  it("allows only the two first-party production hosts", () => {
    expect(isActivationPage("https://geospoof.com", "/activate", true)).toBe(true);
    expect(isActivationPage("https://www.geospoof.com", "/activate", true)).toBe(true);
    expect(isActivationPage("http://geospoof.com", "/activate", true)).toBe(false);
    expect(isActivationPage("https://activate.geospoof.com", "/activate", true)).toBe(false);
    expect(isActivationPage("https://geospoof.com.evil.example", "/activate", true)).toBe(false);
  });

  it("allows only the dedicated route in the top frame", () => {
    expect(isActivationPage("https://geospoof.com", "/activate/", true)).toBe(true);
    expect(isActivationPage("https://geospoof.com", "/de/activate", true)).toBe(true);
    expect(isActivationPage("https://geospoof.com", "/pt-BR/activate/", true)).toBe(true);
    expect(isActivationPage("https://geospoof.com", "/zh-TW/activate", true)).toBe(true);
    expect(isActivationPage("https://geospoof.com", "/zh-tw/activate", true)).toBe(false);
    expect(isActivationPage("https://geospoof.com", "/en/activate", true)).toBe(false);
    expect(isActivationPage("https://geospoof.com", "/de/other/activate", true)).toBe(false);
    expect(isActivationPage("https://geospoof.com", "/verify", true)).toBe(false);
    expect(isActivationPage("https://geospoof.com", "/activate", false)).toBe(false);
  });

  it("allows exact loopback origins only when the development gate is on", () => {
    expect(isActivationPage("https://localhost:3000", "/activate", true, true)).toBe(true);
    expect(isActivationPage("http://127.0.0.1:3000", "/activate", true, true)).toBe(true);
    expect(isActivationPage("https://localhost:3000", "/activate", true, false)).toBe(false);
    expect(isActivationPage("https://localhost:3001", "/activate", true, true)).toBe(false);
    expect(isActivationPage("https://localhost.evil.example:3000", "/activate", true, true)).toBe(
      false
    );
  });
});

describe("activation response", () => {
  it("returns the nonce-bound, data-minimal readiness message", () => {
    expect(activationResponseFor(context())).toEqual({
      source: ACTIVATION_EXTENSION_SOURCE,
      type: ACTIVATION_READY_TYPE,
      protocolVersion: ACTIVATION_PROTOCOL_VERSION,
      nonce: NONCE,
    });
  });

  it("stays silent until settings are loaded and spoofing is ready", () => {
    expect(activationResponseFor(context({ ready: false }))).toBeNull();
  });

  it("responds on localhost only for a development bundle", () => {
    const local = context({
      pageOrigin: "https://localhost:3000",
      eventOrigin: "https://localhost:3000",
      allowDevelopmentOrigins: true,
    });
    expect(activationResponseFor(local)?.nonce).toBe(NONCE);
    expect(activationResponseFor({ ...local, allowDevelopmentOrigins: false })).toBeNull();
  });

  it("rejects messages from another window or origin", () => {
    expect(activationResponseFor(context({ eventSourceIsWindow: false }))).toBeNull();
    expect(activationResponseFor(context({ eventOrigin: "https://geospoof.com" }))).toBeNull();
  });

  it("rejects malformed, stale, and oversized pings", () => {
    expect(activationResponseFor(context({ data: ping({ protocolVersion: 1 as 2 }) }))).toBeNull();
    expect(activationResponseFor(context({ data: ping({ nonce: "too-short" }) }))).toBeNull();
    expect(activationResponseFor(context({ data: ping({ nonce: "x".repeat(129) }) }))).toBeNull();
    expect(
      activationResponseFor(context({ data: ping({ nonce: `${NONCE}<script>` }) }))
    ).toBeNull();
    expect(activationResponseFor(context({ data: { ...ping(), source: "other" } }))).toBeNull();
  });
});

describe("Safari DOM-event transport", () => {
  it("answers a valid ping synchronously without MessageEvent realm identity", () => {
    window.history.replaceState(null, "", "/activate");
    let received: unknown;
    const receiveReady = (event: Event): void => {
      received = (event as CustomEvent<unknown>).detail;
    };
    window.addEventListener(ACTIVATION_READY_EVENT, receiveReady);
    const cleanup = installActivationResponder(
      () => true,
      () => {},
      true
    );

    window.dispatchEvent(new CustomEvent(ACTIVATION_PING_EVENT, { detail: ping() }));

    expect(received).toEqual({
      source: ACTIVATION_EXTENSION_SOURCE,
      type: ACTIVATION_READY_TYPE,
      protocolVersion: ACTIVATION_PROTOCOL_VERSION,
      nonce: NONCE,
    });

    cleanup();
    window.removeEventListener(ACTIVATION_READY_EVENT, receiveReady);
  });
});

// The wire-format parity check — asserting these constants match the hosted
// activation page's copy — is NOT here. It lives in the geospoof-site repo, in
// src/lib/activation/protocol.parity.test.ts, which reads this file's constants
// through a submodule and runs on every push plus daily.
//
// It moved because the marketing site is now a private repo, and a public repo
// cannot consume a private submodule. The dependency direction had to flip.
//
// Changing any constant in @/shared/activation-protocol is therefore a
// cross-repo change: the page and the extension talk across a
// postMessage/DOM-event boundary, nothing compiles both halves, and a mismatch
// fails activation silently rather than failing a build.
