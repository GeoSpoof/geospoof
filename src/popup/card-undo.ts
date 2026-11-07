/**
 * The This site card's undo (direction.md 6.1, "Undo"): after a card Remove
 * of entry E from list L, the card's next Add puts back E exactly as it was
 * stored, so `=mail.example.com` doesn't come back as `mail.example.com`.
 *
 * Any other write, a tab change, or closing the popup clears it. Module
 * state only, and no runtime imports, so every writer can clear it.
 */

import type { CardUndo } from "./this-site";

let record: CardUndo | null = null;

export function getCardUndo(): CardUndo | null {
  return record;
}

export function setCardUndo(next: CardUndo): void {
  record = next;
}

export function clearCardUndo(): void {
  record = null;
}
