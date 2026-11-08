/**
 * Settings card captions: one caption per card, by precedence.
 *
 * Each card is followed by a caption group (`[data-caption-group]`) whose
 * children with `data-caption` are its candidates. At most one shows, ranked:
 *
 *   1. `error`    — a validation error, while `data-active="true"`;
 *   2. `info`     — the text of an open ⓘ (its button has `aria-expanded="true"`);
 *   3. `standing` — the card's own caption, unless `data-active="false"`.
 *
 * Markup order breaks ties, so a warning listed before a hint wins over it.
 * Only one ⓘ is open per card. An ⓘ that an error outranks is closed, so its
 * `aria-expanded` never claims a caption that isn't showing.
 */

export type CaptionKind = "error" | "info" | "standing";

const RANK: Record<CaptionKind, number> = { error: 0, info: 1, standing: 2 };

/**
 * The index of the caption to show: the first eligible candidate of the best
 * rank, or -1 when none is eligible.
 */
export function pickCaption(
  candidates: ReadonlyArray<{ kind: CaptionKind; eligible: boolean }>
): number {
  let best = -1;
  candidates.forEach((candidate, i) => {
    if (!candidate.eligible) return;
    if (best === -1 || RANK[candidate.kind] < RANK[candidates[best].kind]) best = i;
  });
  return best;
}

function candidatesOf(group: Element): HTMLElement[] {
  return Array.from(group.children).filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el.hasAttribute("data-caption")
  );
}

function kindOf(el: HTMLElement): CaptionKind {
  const kind = el.dataset.caption;
  return kind === "error" || kind === "info" ? kind : "standing";
}

function infoButtonFor(el: HTMLElement): HTMLElement | null {
  if (!el.id) return null;
  return document.querySelector<HTMLElement>(`.info-icon[aria-controls="${el.id}"]`);
}

/** Show the one caption a group should show, and hide the rest. */
export function renderCaptionGroup(group: Element): void {
  const candidates = candidatesOf(group);
  const states = candidates.map((el) => {
    const kind = kindOf(el);
    let eligible: boolean;
    if (kind === "error") eligible = el.dataset.active === "true";
    else if (kind === "info")
      eligible = infoButtonFor(el)?.getAttribute("aria-expanded") === "true";
    else eligible = el.dataset.active === undefined || el.dataset.active === "true";
    return { kind, eligible };
  });
  const chosen = pickCaption(states);
  candidates.forEach((el, i) => {
    el.hidden = i !== chosen;
    // An open ⓘ outranked by an error closes, so its state stays truthful.
    if (i !== chosen && states[i].kind === "info" && states[i].eligible) {
      infoButtonFor(el)?.setAttribute("aria-expanded", "false");
    }
  });
}

/** Turn an error or standing caption on or off, and re-render its group. */
export function setCaptionActive(el: HTMLElement | null, active: boolean): void {
  if (!el) return;
  el.dataset.active = active ? "true" : "false";
  const group = el.closest("[data-caption-group]");
  if (group) renderCaptionGroup(group);
}

function groupOfButton(button: Element): Element | null {
  const id = button.getAttribute("aria-controls");
  const caption = id ? document.getElementById(id) : null;
  return caption?.closest("[data-caption-group]") ?? null;
}

let documentListenerWired = false;
const wiredButtons = new Set<HTMLElement>();

/** Close every wired ⓘ and re-render their groups. */
function closeAll(): void {
  const groups = new Set<Element>();
  for (const button of wiredButtons) {
    if (!button.isConnected) {
      wiredButtons.delete(button);
      continue;
    }
    if (button.getAttribute("aria-expanded") === "true") {
      button.setAttribute("aria-expanded", "false");
      const group = groupOfButton(button);
      if (group) groups.add(group);
    }
  }
  groups.forEach(renderCaptionGroup);
}

/**
 * Wire every `.info-icon[aria-controls]` under `root`. A click toggles its
 * caption and closes the other ⓘ in the same group; a click anywhere else
 * closes them all, as the popup's other info tooltips do. Idempotent.
 */
export function wireInfoButtons(root: ParentNode | null): void {
  if (!root) return;
  root.querySelectorAll<HTMLElement>(".info-icon[aria-controls]").forEach((button) => {
    if (button.dataset.infoWired === "1") return;
    button.dataset.infoWired = "1";
    wiredButtons.add(button);
    if (!button.hasAttribute("aria-expanded")) button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", (e: Event) => {
      // The ⓘ sits inside a row's <label>: don't let the click toggle the switch.
      e.preventDefault();
      e.stopPropagation();
      const open = button.getAttribute("aria-expanded") !== "true";
      const group = groupOfButton(button);
      if (group) {
        for (const caption of candidatesOf(group)) {
          const other = infoButtonFor(caption);
          if (other && other !== button) other.setAttribute("aria-expanded", "false");
        }
      }
      button.setAttribute("aria-expanded", open ? "true" : "false");
      if (group) renderCaptionGroup(group);
    });
  });
  root.querySelectorAll("[data-caption-group]").forEach(renderCaptionGroup);

  if (!documentListenerWired) {
    documentListenerWired = true;
    document.addEventListener("click", (e: Event) => {
      const target = e.target as Element | null;
      if (target && typeof target.closest === "function") {
        const button = target.closest<HTMLElement>(".info-icon");
        if (button && wiredButtons.has(button)) return;
      }
      closeAll();
    });
  }
}

/** Test hook: forget wired buttons (the document listener stays, harmlessly). */
export function __resetCaptionsForTest(): void {
  wiredButtons.clear();
}
