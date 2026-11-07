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
  row.appendChild(line);

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
    row.appendChild(sub);
  }

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
