import {
  ACTIVATION_PING_EVENT,
  ACTIVATION_READY_EVENT,
  isActivationPingMessage,
  makeActivationReady,
  type ActivationReadyMessage,
} from "@/shared/activation-protocol";

/** Both hosts are first-party; the AppLink helper currently uses the www host. */
export const ACTIVATION_ORIGINS = new Set(["https://geospoof.com", "https://www.geospoof.com"]);

// Keep this closed to the site's actual localized activation routes. A broad
// suffix match would unnecessarily expose the responder to unrelated pages.
const ACTIVATION_PATH_PATTERN = /^\/(?:(?:de|es|fr|id|ja|pt-BR|ru|zh-CN|zh-TW)\/)?activate\/?$/;

const IS_DEVELOPMENT_BUILD = process.env.NODE_ENV === "development";

/** Local site origins accepted only by an explicitly development-mode bundle. */
export function isDevelopmentActivationOrigin(origin: string): boolean {
  return (
    origin === "https://localhost:3000" ||
    origin === "http://localhost:3000" ||
    origin === "https://127.0.0.1:3000" ||
    origin === "http://127.0.0.1:3000"
  );
}

export interface ActivationMessageContext {
  pageOrigin: string;
  pagePathname: string;
  isTopFrame: boolean;
  eventOrigin: string;
  eventSourceIsWindow: boolean;
  data: unknown;
  ready: boolean;
  allowDevelopmentOrigins?: boolean;
}

/**
 * The responder is intentionally limited to the dedicated first-party route.
 * Query parameters are harmless (the app adds UTM tags), but other paths,
 * origins, and every iframe are rejected.
 */
export function isActivationPage(
  origin: string,
  pathname: string,
  isTopFrame: boolean,
  allowDevelopmentOrigins = IS_DEVELOPMENT_BUILD
): boolean {
  return (
    isTopFrame &&
    (ACTIVATION_ORIGINS.has(origin) ||
      (allowDevelopmentOrigins && isDevelopmentActivationOrigin(origin))) &&
    ACTIVATION_PATH_PATTERN.test(pathname)
  );
}

/**
 * Pure decision boundary for the page-to-extension handshake. Returning null
 * means silence: absence, missing site access, restrictions, settings still
 * loading, and spoofing being off remain intentionally indistinguishable.
 */
export function activationResponseFor(
  context: ActivationMessageContext
): ActivationReadyMessage | null {
  if (
    !context.ready ||
    !isActivationPage(
      context.pageOrigin,
      context.pagePathname,
      context.isTopFrame,
      context.allowDevelopmentOrigins
    ) ||
    !context.eventSourceIsWindow ||
    context.eventOrigin !== context.pageOrigin ||
    !isActivationPingMessage(context.data)
  ) {
    return null;
  }

  return makeActivationReady(context.data.nonce);
}

/**
 * Install the MAIN-world listener after the spoofing overrides are installed.
 * Only a minimal readiness message is posted back—never coordinates, settings,
 * an install id, or entitlement data.
 */
export function installActivationResponder(
  isReady: () => boolean,
  debug: (message: string) => void = () => {},
  allowDevelopmentOrigins = IS_DEVELOPMENT_BUILD
): () => void {
  const pageOrigin = window.location.origin;
  const pagePathname = window.location.pathname;
  const isTopFrame = window.top === window;

  if (!isActivationPage(pageOrigin, pagePathname, isTopFrame, allowDevelopmentOrigins)) {
    if (isTopFrame && ACTIVATION_PATH_PATTERN.test(pagePathname)) {
      debug(`Activation responder blocked for untrusted origin: ${pageOrigin}`);
    }
    return () => {};
  }

  debug(`Activation responder armed for ${pageOrigin}${pagePathname}`);

  const responseFor = (data: unknown): ActivationReadyMessage | null =>
    activationResponseFor({
      pageOrigin,
      // Re-read the path so a same-document history navigation away from the
      // activation route immediately loses access to the responder.
      pagePathname: window.location.pathname,
      isTopFrame,
      // CustomEvent is confined to this document. Supplying the already-gated
      // page origin and window identity lets it share the same pure validator.
      eventOrigin: pageOrigin,
      eventSourceIsWindow: true,
      data,
      ready: isReady(),
      allowDevelopmentOrigins,
    });

  const onActivationEvent = (event: Event): void => {
    const response = responseFor((event as CustomEvent<unknown>).detail);
    if (!response) return;

    window.dispatchEvent(new CustomEvent(ACTIVATION_READY_EVENT, { detail: response }));
    debug("Activation page readiness confirmed via DOM event");
  };

  const onMessage = (event: MessageEvent<unknown>): void => {
    const response = activationResponseFor({
      pageOrigin,
      // Re-read the path so a same-document history navigation away from the
      // activation route immediately loses access to the responder.
      pagePathname: window.location.pathname,
      isTopFrame,
      eventOrigin: event.origin,
      eventSourceIsWindow: event.source === window,
      data: event.data,
      ready: isReady(),
      allowDevelopmentOrigins,
    });

    if (response) {
      window.postMessage(response, pageOrigin);
      debug("Activation page readiness confirmed via postMessage");
    }
  };

  window.addEventListener(ACTIVATION_PING_EVENT, onActivationEvent);
  window.addEventListener("message", onMessage);
  return () => {
    window.removeEventListener(ACTIVATION_PING_EVENT, onActivationEvent);
    window.removeEventListener("message", onMessage);
  };
}
