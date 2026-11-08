/**
 * The site row (direction.md 4.2, "One row component"): one component for
 * the This site card and the Per-site locations list.
 *
 *   <div class="site-row" role="button" tabindex="0" aria-describedby="sl-0-desc">
 *     <div class="site-row-line">
 *       <span class="site-row-host">example.<wbr>com</span>
 *       <span class="site-row-trail"><span class="site-row-value">Paris</span>&nbsp;<span class="site-row-chev" aria-hidden="true">›</span></span>
 *     </div>
 *     <div class="site-row-sub">Per-site location</div>
 *   </div>
 *   <span class="visually-hidden" id="sl-0-desc">Change the location for example.com</span>
 *
 * The site breaks between labels; the › follows the value through a no-break
 * space, so it always sits on the value's line. A row that opens nothing is
 * plain text: no role, no tab stop, no ›, no description.
 */

import { wireButtonRow } from "./filters-nav";

export interface SiteRowOptions {
  /** The site (or sites, joined by ", "). */
  host: string;
  /** "Off", "Not set", or a place. */
  value: string;
  /** The line under the site: the value's source, or a mark. */
  sub?: string | null;
  /** The line under the site is a mark: `--warn-text`, after an `aria-hidden` ⚠. */
  warn?: boolean;
  /** The row opens something: a button with a ›, a Tab stop and a description. */
  opens?: boolean;
  /** What opening does, read as the row's description. */
  description?: string | null;
  /** Prefixes the description's id (`<idPrefix>-desc`). */
  idPrefix: string;
  /** An id for the value, so a button that follows can be described by it. */
  valueId?: string | null;
  /** Click, Enter or Space on an opening row. */
  onActivate?: (() => void) | null;
  /** A decorative letter badge before the text (`buildMonogram`), from this name. */
  badge?: string | null;
}

export interface SiteRow {
  row: HTMLElement;
  /** The visually hidden description; append it after the row. Null when the row opens nothing. */
  description: HTMLElement | null;
}

/** The site with a break opportunity after each dot. */
function appendHost(parent: HTMLElement, host: string): void {
  const parts = host.split(".");
  parts.forEach((part, index) => {
    const last = index === parts.length - 1;
    parent.appendChild(document.createTextNode(last ? part : `${part}.`));
    if (!last) parent.appendChild(document.createElement("wbr"));
  });
}

export function buildSiteRow(opts: SiteRowOptions): SiteRow {
  const opens = opts.opens === true;
  const row = document.createElement("div");
  row.className = "site-row";

  const line = document.createElement("div");
  line.className = "site-row-line";
  const host = document.createElement("span");
  host.className = "site-row-host";
  appendHost(host, opts.host);

  // No whitespace but the no-break space between the value and its ›, so no
  // line can break there.
  const trail = document.createElement("span");
  trail.className = "site-row-trail";
  const value = document.createElement("span");
  value.className = "site-row-value";
  if (opts.valueId) value.id = opts.valueId;
  value.textContent = opts.value;
  trail.appendChild(value);
  if (opens) {
    trail.appendChild(document.createTextNode("\u00A0"));
    const chev = document.createElement("span");
    chev.className = "site-row-chev";
    chev.setAttribute("aria-hidden", "true");
    chev.textContent = "›";
    trail.appendChild(chev);
  }
  line.append(host, trail);
  // The text sits in a body (beside the badge, when there is one, so the
  // badge never shrinks); the stacked layout rearranges what's inside it.
  if (opts.badge) {
    row.classList.add("with-badge");
    row.appendChild(buildMonogram(opts.badge));
  }
  const body = document.createElement("div");
  body.className = "site-row-body";
  row.appendChild(body);
  body.appendChild(line);

  if (opts.sub) {
    const sub = document.createElement("div");
    sub.className = opts.warn ? "site-row-sub warn" : "site-row-sub";
    if (opts.warn) {
      const sign = document.createElement("span");
      sign.setAttribute("aria-hidden", "true");
      sign.textContent = "⚠ ";
      sub.appendChild(sign);
    }
    sub.appendChild(document.createTextNode(opts.sub));
    body.appendChild(sub);
  }

  fitSiteRow(row);

  let description: HTMLElement | null = null;
  if (opens) {
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    if (opts.description) {
      description = document.createElement("span");
      description.className = "visually-hidden";
      description.id = `${opts.idPrefix}-desc`;
      description.textContent = opts.description;
      row.setAttribute("aria-describedby", description.id);
    }
    if (opts.onActivate) wireButtonRow(row, opts.onActivate);
  }
  return { row, description };
}

/** One line of the row's text is 20 px; anything taller has wrapped. */
const ONE_LINE_MAX = 22;

interface Box {
  top: number;
  height: number;
}

/**
 * Whether a row needs the stacked layout, from its side-by-side boxes: the
 * value went to its own line (its top isn't the site's), or the site or the
 * value wrapped. Measured, never guessed from the text's length.
 */
export function siteRowNeedsStack(host: Box, trail: Box): boolean {
  return (
    Math.abs(trail.top - host.top) > 1 || host.height > ONE_LINE_MAX || trail.height > ONE_LINE_MAX
  );
}

/**
 * Lay a site row out, by measuring: side by side ("twitch.tv   Off") when the
 * site and the value share a line, or stacked when they don't: the site on
 * line 1, then the value and, when it fits, "· source" on line 2 (otherwise
 * the source on line 3), with the › centred at the right of the row.
 */
export function refitSiteRow(row: HTMLElement): void {
  const host = row.querySelector<HTMLElement>(".site-row-host");
  const trail = row.querySelector<HTMLElement>(".site-row-trail");
  if (!host || !trail || row.getClientRects().length === 0) return;
  row.classList.remove("stacked", "sub-below");
  const h = host.getBoundingClientRect();
  const t = trail.getBoundingClientRect();
  if (!siteRowNeedsStack(h, t)) return;
  row.classList.add("stacked");
  const value = row.querySelector<HTMLElement>(".site-row-value");
  const sub = row.querySelector<HTMLElement>(".site-row-sub");
  if (!value || !sub) return;
  // The source goes on line 3 when it doesn't fit after the value.
  const v = value.getClientRects();
  const lastValueTop = v.length > 0 ? v[v.length - 1].top : value.getBoundingClientRect().top;
  if (sub.getBoundingClientRect().top - lastValueTop > 1) row.classList.add("sub-below");
}

const fitted = new WeakMap<HTMLElement, number>();
let observer: ResizeObserver | null = null;

/**
 * Keep `row` laid out as its width changes, including when it first becomes
 * visible. Content changes call refitSiteRow. A no-op without ResizeObserver
 * (jsdom), where the side-by-side layout stays.
 */
export function fitSiteRow(row: HTMLElement): void {
  if (typeof ResizeObserver === "undefined") return;
  observer ??= new ResizeObserver((entries) => {
    for (const entry of entries) {
      const el = entry.target as HTMLElement;
      const width = Math.round(entry.contentRect.width);
      // Only a new width can change the fit; the layout's own height change can't.
      if (width === 0 || fitted.get(el) === width) continue;
      fitted.set(el, width);
      refitSiteRow(el);
    }
  });
  observer.observe(row);
}

/**
 * Deterministic hue (0–359) derived from the domain string, so each site keeps
 * a stable colour across renders without any stored state.
 */
function monogramHue(domain: string): number {
  let hash = 0;
  for (let i = 0; i < domain.length; i++) {
    hash = (hash * 31 + domain.charCodeAt(i)) % 360;
  }
  return hash;
}

/**
 * Build a decorative monogram tile for a domain: the first character on a
 * deterministic coloured background. Generated entirely locally — we never
 * fetch a favicon, so the user's site list never leaves the device (a network
 * request, even for a public icon, would reveal the list to that host or a
 * third-party favicon service).
 */
export function buildMonogram(domain: string): HTMLElement {
  const tile = document.createElement("span");
  tile.className = "scope-site-icon";
  tile.setAttribute("aria-hidden", "true");
  tile.textContent = (domain.charAt(0) || "?").toUpperCase();
  tile.style.backgroundColor = `hsl(${monogramHue(domain)}, 52%, 38%)`;
  return tile;
}

/**
 * The meta text of an entry row or chip ("964 sites"). A warning ("Not
 * available") gets a ⚠ sign and the `warning` class, so it isn't colour alone.
 */
export function buildEntryMeta(meta: string, warning: boolean, className: string): HTMLElement {
  const metaEl = document.createElement("span");
  metaEl.className = warning ? `${className} warning` : className;
  if (warning) {
    const sign = document.createElement("span");
    sign.setAttribute("aria-hidden", "true");
    sign.textContent = "⚠ ";
    metaEl.appendChild(sign);
  }
  metaEl.appendChild(document.createTextNode(meta));
  return metaEl;
}
