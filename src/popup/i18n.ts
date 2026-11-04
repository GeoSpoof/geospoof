/**
 * Popup Internationalization
 *
 * By default the popup localizes through the native `browser.i18n.getMessage`,
 * which is keyed to the *browser UI language* and cannot be redirected at
 * runtime. To let users override the popup language independently of the
 * browser (see the Advanced-section picker), we layer an optional catalog on
 * top: `initI18n(locale)` fetches `_locales/<locale>/messages.json` (plus the
 * English catalog as a missing-key fallback) and `t()` consults it first.
 *
 * When no override is active (the common case), `active` is null and `t()`
 * delegates straight to `browser.i18n.getMessage` — identical behavior and zero
 * overhead versus not having this feature at all.
 *
 * DOM application: `applyI18n()` walks any element carrying a `data-i18n*`
 * attribute. The popup HTML ships English text as the static fallback; the
 * first `applyI18n()` replaces it with the resolved language, and a language
 * change re-runs it to re-translate live.
 *
 * Supported attributes:
 *   data-i18n              — element.textContent
 *   data-i18n-placeholder  — element.placeholder (inputs)
 *   data-i18n-title        — element.title (tooltips)
 *   data-i18n-aria-label   — element.setAttribute("aria-label", …)
 */

/** Raw `_locales/<lang>/messages.json` entry shape. */
interface MessageEntry {
  message: string;
  placeholders?: Record<string, { content: string }>;
}
type MessagesCatalog = Record<string, MessageEntry>;

/**
 * Active override catalog + its English fallback. Both null unless the user has
 * chosen a UI language other than the browser's (via `initI18n`). While null,
 * `t()` uses the native `browser.i18n.getMessage` path.
 */
let activeCatalog: MessagesCatalog | null = null;
let fallbackCatalog: MessagesCatalog | null = null;
let activeLocale: string | null = null;

/** Fetch a packaged locale catalog from the extension bundle, or null on failure. */
async function fetchCatalog(locale: string): Promise<MessagesCatalog | null> {
  try {
    const url = browser.runtime.getURL(`_locales/${locale}/messages.json`);
    const response = await fetch(url);
    if (!response.ok) return null;
    return (await response.json()) as MessagesCatalog;
  } catch {
    return null;
  }
}

/**
 * Activate a UI-language override: load `locale`'s catalog as the primary
 * lookup and English as the missing-key fallback. Idempotent — re-requesting
 * the already-active locale is a no-op. If the catalog can't be fetched, the
 * override is cleared so the popup falls back to the native browser path rather
 * than blanking out.
 *
 * Call `applyI18n()` afterward to re-translate the DOM.
 */
export async function initI18n(locale: string): Promise<void> {
  if (locale === activeLocale) return;

  const catalog = await fetchCatalog(locale);
  if (!catalog) {
    resetI18nOverride();
    return;
  }

  activeCatalog = catalog;
  fallbackCatalog = locale === "en" ? catalog : await fetchCatalog("en");
  activeLocale = locale;
}

/**
 * Drop any override and revert to the native `browser.i18n` path (the browser
 * UI language). Used when the user selects "System" in the picker.
 */
export function resetI18nOverride(): void {
  activeCatalog = null;
  fallbackCatalog = null;
  activeLocale = null;
}

/** The browser UI language, read defensively (empty string in bare contexts). */
export function browserUiLanguage(): string {
  try {
    return browser.i18n.getUILanguage();
  } catch {
    return "";
  }
}

/**
 * The popup's active UI language as a BCP 47 tag (`pt-BR`), for `Intl`
 * formatting: the override when one is active, else the browser UI language.
 * Empty when neither is known, so `Intl` falls back to its default.
 */
export function uiLocale(): string {
  return (activeLocale ?? browserUiLanguage()).replace(/_/g, "-");
}

/**
 * Replicate `browser.i18n.getMessage` substitution for a raw catalog entry:
 * resolve named `$PLACEHOLDER$` tokens (case-insensitive) to their `content`
 * (which may itself reference positional `$1`…`$9`), then substitute any bare
 * positional refs, then unescape `$$` → `$`.
 *
 * Exported for unit testing; not part of the public i18n surface.
 */
export function substitutePlaceholders(
  entry: MessageEntry,
  substitutions?: string | string[]
): string {
  const args =
    substitutions === undefined
      ? []
      : Array.isArray(substitutions)
        ? substitutions
        : [substitutions];
  let message = entry.message;

  // 1. Expand named `$PLACEHOLDER$` tokens to their content (which may itself
  //    contain positional `$1`…`$9` refs that the final pass then fills).
  if (entry.placeholders) {
    for (const [name, def] of Object.entries(entry.placeholders)) {
      message = message.replace(new RegExp(`\\$${escapeRegExp(name)}\\$`, "gi"), def.content);
    }
  }

  // 2. Single left-to-right pass so `$$` is consumed atomically as an escaped
  //    literal `$` and never mistaken for the `$` of a positional ref.
  return message.replace(/\$(\$|[1-9])/g, (_match, token: string) =>
    token === "$" ? "$" : (args[Number(token) - 1] ?? "")
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Look up a localized message, with optional positional substitutions.
 *
 * When a UI-language override is active, the chosen catalog is consulted first,
 * then the English fallback; only if a key is missing from both do we fall
 * through to the native API. With no override, this is a thin pass-through to
 * `browser.i18n.getMessage`. Returns the empty string if the key is undefined
 * everywhere, so the popup keeps its static English markup rather than blanking.
 */
export function t(key: string, substitutions?: string | string[]): string {
  if (activeCatalog) {
    const entry = activeCatalog[key] ?? fallbackCatalog?.[key];
    if (entry) return substitutePlaceholders(entry, substitutions);
    // Missing from both the override and English fallback — fall through to the
    // native lookup below (defensive; the English catalog is the source of truth).
  }

  try {
    return browser.i18n.getMessage(key, substitutions) || "";
  } catch {
    // Defensive: `browser.i18n` is always present in extension contexts, but if
    // the popup is opened in a bare page context (tests, standalone preview)
    // fall through to the empty string so the English markup is preserved.
    return "";
  }
}

type I18nAttribute = {
  /** HTML attribute to read the message key from. */
  dataAttr: string;
  /** Applies the resolved message to the element. */
  apply(el: HTMLElement, msg: string): void;
};

const ATTRIBUTES: I18nAttribute[] = [
  {
    dataAttr: "data-i18n",
    apply: (el, msg) => {
      el.textContent = msg;
    },
  },
  {
    dataAttr: "data-i18n-placeholder",
    apply: (el, msg) => {
      if ("placeholder" in el) {
        (el as HTMLInputElement).placeholder = msg;
      }
    },
  },
  {
    dataAttr: "data-i18n-title",
    apply: (el, msg) => {
      el.title = msg;
    },
  },
  {
    dataAttr: "data-i18n-aria-label",
    apply: (el, msg) => {
      el.setAttribute("aria-label", msg);
    },
  },
];

/**
 * Walk `root` and translate every element tagged with a `data-i18n*`
 * attribute. Safe to call multiple times (idempotent).
 */
export function applyI18n(root: ParentNode = document): void {
  for (const attr of ATTRIBUTES) {
    const els = Array.from(root.querySelectorAll<HTMLElement>(`[${attr.dataAttr}]`));
    for (const el of els) {
      const key = el.getAttribute(attr.dataAttr);
      if (!key) continue;
      const msg = t(key);
      if (msg) attr.apply(el, msg);
    }
  }
}
