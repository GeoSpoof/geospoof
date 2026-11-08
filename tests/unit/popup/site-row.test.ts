/**
 * The site row (direction.md 4.2, "One row component"), shared by the This
 * site card and the Per-site locations screen: its markup, and how a row
 * that opens something is wired.
 */

import { describe, test, expect, vi } from "vitest";
import { buildEntryMeta, buildSiteRow, siteRowNeedsStack } from "@/popup/site-row";

describe("buildSiteRow", () => {
  test("the site breaks between labels: a <wbr> after each dot", () => {
    const { row } = buildSiteRow({ host: "mail.example.com", value: "Paris", idPrefix: "r" });
    const host = row.querySelector(".site-row-host")!;
    expect(host.innerHTML).toBe("mail.<wbr>example.<wbr>com");
    expect(host.textContent).toBe("mail.example.com");
  });

  test("a row that opens: a button with a ›, joined to the value by a no-break space", () => {
    const { row, description } = buildSiteRow({
      host: "example.com",
      value: "Paris",
      opens: true,
      description: "Change the location for example.com",
      idPrefix: "sl-0",
    });
    expect(row.className).toBe("site-row");
    expect(row.getAttribute("role")).toBe("button");
    expect(row.getAttribute("tabindex")).toBe("0");

    const line = row.querySelector(".site-row-line")!;
    expect(Array.from(line.children).map((c) => c.className)).toEqual([
      "site-row-host",
      "site-row-trail",
    ]);
    const trail = row.querySelector(".site-row-trail")!;
    // Nothing but the no-break space between the value and its ›.
    expect(trail.childNodes).toHaveLength(3);
    expect(trail.textContent).toBe("Paris\u00A0›");
    expect((trail.childNodes[0] as HTMLElement).className).toBe("site-row-value");
    expect(trail.childNodes[1].nodeType).toBe(Node.TEXT_NODE);
    const chev = trail.querySelector(".site-row-chev")!;
    expect(chev.getAttribute("aria-hidden")).toBe("true");
    expect(chev.textContent).toBe("›");

    // The description is a visually hidden sibling the row points at.
    expect(description).not.toBeNull();
    expect(description!.id).toBe("sl-0-desc");
    expect(description!.className).toBe("visually-hidden");
    expect(description!.textContent).toBe("Change the location for example.com");
    expect(row.getAttribute("aria-describedby")).toBe("sl-0-desc");
    expect(row.contains(description)).toBe(false);
  });

  test("a plain row: no role, no tab stop, no ›, no description", () => {
    const { row, description } = buildSiteRow({
      host: "twitch.tv",
      value: "Off",
      description: "ignored",
      idPrefix: "card",
      valueId: "card-value",
    });
    expect(row.hasAttribute("role")).toBe(false);
    expect(row.hasAttribute("tabindex")).toBe(false);
    expect(row.hasAttribute("aria-describedby")).toBe(false);
    expect(row.querySelector(".site-row-chev")).toBeNull();
    expect(row.querySelector(".site-row-trail")!.textContent).toBe("Off");
    expect(description).toBeNull();
    // The value can carry an id, so a button after the row can be described by it.
    expect(row.querySelector(".site-row-value")!.id).toBe("card-value");
  });

  test("the line under the site: muted, or a mark after an aria-hidden ⚠", () => {
    const plain = buildSiteRow({
      host: "example.com",
      value: "Paris",
      sub: "Per-site location",
      idPrefix: "a",
    }).row.querySelector(".site-row-sub")!;
    expect(plain.className).toBe("site-row-sub");
    expect(plain.textContent).toBe("Per-site location");

    const mark = buildSiteRow({
      host: "twitch.tv",
      value: "Los Angeles",
      sub: "Not used · Off in Sites",
      warn: true,
      idPrefix: "b",
    }).row.querySelector(".site-row-sub")!;
    expect(mark.className).toBe("site-row-sub warn");
    expect(mark.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    expect(mark.firstElementChild?.textContent).toBe("⚠ ");
    expect(mark.textContent).toBe("⚠ Not used · Off in Sites");

    expect(
      buildSiteRow({ host: "a.com", value: "Tokyo", idPrefix: "c" }).row.querySelector(
        ".site-row-sub"
      )
    ).toBeNull();
  });

  test("an opening row with no description isn't described by an empty element", () => {
    const { row, description } = buildSiteRow({
      host: "a.com",
      value: "Tokyo",
      opens: true,
      idPrefix: "d",
    });
    expect(description).toBeNull();
    expect(row.hasAttribute("aria-describedby")).toBe(false);
  });

  test("click, Enter and Space activate an opening row; aria-disabled makes it inert", () => {
    const onActivate = vi.fn();
    const { row } = buildSiteRow({
      host: "a.com",
      value: "Tokyo",
      opens: true,
      idPrefix: "e",
      onActivate,
    });
    row.click();
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    row.dispatchEvent(enter);
    const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    row.dispatchEvent(space);
    expect(onActivate).toHaveBeenCalledTimes(3);
    // Space doesn't scroll the popup.
    expect(space.defaultPrevented).toBe(true);

    row.setAttribute("aria-disabled", "true");
    row.click();
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onActivate).toHaveBeenCalledTimes(3);
  });
});

describe("buildEntryMeta", () => {
  test("a warning gets the class and an aria-hidden ⚠, so it isn't colour alone", () => {
    const meta = buildEntryMeta("Not available", true, "scope-site-meta");
    expect(meta.className).toBe("scope-site-meta warning");
    expect(meta.textContent).toBe("⚠ Not available");
    expect(meta.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    expect(buildEntryMeta("Site group · 964 sites", false, "entry-chip-meta").outerHTML).toBe(
      '<span class="entry-chip-meta">Site group · 964 sites</span>'
    );
  });
});

describe("the stacked layout rule", () => {
  test("stacks when the value leaves the site's line or either wraps", () => {
    expect(siteRowNeedsStack({ top: 150, height: 20 }, { top: 150, height: 20 })).toBe(false);
    // The value went to its own line: the reported bug.
    expect(siteRowNeedsStack({ top: 150, height: 20 }, { top: 172, height: 20 })).toBe(true);
    // A long site or a long place wraps.
    expect(siteRowNeedsStack({ top: 150, height: 60 }, { top: 150, height: 20 })).toBe(true);
    expect(siteRowNeedsStack({ top: 150, height: 20 }, { top: 150, height: 40 })).toBe(true);
  });

  test("every row has a body, and jsdom (no layout) keeps the side-by-side layout", () => {
    const { row } = buildSiteRow({
      host: "webbrowsertools.com",
      value: "Tokyo, Japan",
      idPrefix: "x",
    });
    expect(row.firstElementChild?.className).toBe("site-row-body");
    expect(row.classList.contains("stacked")).toBe(false);
  });
});
