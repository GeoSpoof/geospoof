/**
 * The shared add control (GeoSpoof/geospoof#206, K1), against the real
 * Filters markup in assets/popup.html: one field with suggestions (manual
 * selection), typing auto-detect, "Browse all site groups…", the link busy
 * state, inline errors, and the Safari gate.
 */

import { describe, test, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { EntryInputKind } from "@/shared/utils/filter-entries";

const gate = vi.hoisted(() => ({ available: true }));
vi.mock("@/shared/site-groups/availability", () => ({
  siteGroupsAvailable: () => gate.available,
}));

import {
  createEntryAddControl,
  type EntryAddControl,
  type EntrySubmitResult,
} from "@/popup/entry-add-control";
import { __resetPopupSiteGroupsForTest, describeEntry, formatCount } from "@/popup/site-groups";

const HTML = readFileSync("assets/popup.html", "utf8");
const BODY = new DOMParser().parseFromString(HTML, "text/html").body.innerHTML;

const sendMessage = vi.mocked(browser.runtime.sendMessage);

const INDEX = {
  release: "20261104112839",
  lists: [
    { name: "category-ads-all", count: 6000 },
    { name: "google", count: 964 },
    { name: "google-cn", count: 12 },
    { name: "netflix", count: 40 },
    { name: "twitch", count: 35 },
  ],
};

const ERROR_SITE_OR_GROUP = "Use a site like example.com, or pick a site group below.";

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing`);
  return node as T;
}

const input = () => byId<HTMLInputElement>("scopeAddInput");
const addButton = () => byId<HTMLButtonElement>("scopeAddButton");
const listbox = () => byId("scopeGroupListbox");
const attribution = () => byId("scopeGroupAttribution");
const errorEl = () => byId("scopeAddError");

let onSubmit: ReturnType<
  typeof vi.fn<(entries: string[], kind: EntryInputKind) => Promise<EntrySubmitResult>>
>;

function create(context: "filters" | "siteLocation" = "filters"): EntryAddControl {
  const control = createEntryAddControl({
    ids: {
      input: "scopeAddInput",
      button: "scopeAddButton",
      listbox: "scopeGroupListbox",
      attribution: "scopeGroupAttribution",
      error: "scopeAddError",
    },
    context,
    onSubmit,
  });
  if (!control) throw new Error("no control");
  return control;
}

function type(value: string): void {
  input().value = value;
  input().dispatchEvent(new Event("input"));
}

function key(name: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  input().dispatchEvent(event);
  return event;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** Let the site group index load (it's requested on the first suggestions). */
async function indexLoaded(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function errorShown(): boolean {
  return errorEl().style.display === "block";
}

function options(): HTMLElement[] {
  return Array.from(listbox().querySelectorAll<HTMLElement>("[role='option']"));
}

/** Each suggestion row as "title · meta", and the Browse row by its text. */
function rows(): string[] {
  return options().map((o) => {
    const title = o.querySelector(".entry-suggestion-title")?.textContent;
    const meta = o.querySelector(".entry-suggestion-meta")?.textContent;
    return title === undefined ? (o.textContent ?? "") : `${title} · ${meta}`;
  });
}

function optionByText(text: string): HTMLElement {
  const option = options().find((o) => o.textContent?.startsWith(text));
  if (!option) throw new Error(`no option ${text}`);
  return option;
}

function indexRequests(): number {
  return sendMessage.mock.calls.filter(
    ([m]) => (m as unknown as { type: string }).type === "GET_SITE_GROUP_INDEX"
  ).length;
}

beforeEach(() => {
  gate.available = true;
  document.body.innerHTML = BODY;
  // Show the Filters list manager, as a list mode does.
  byId("mainView").style.display = "none";
  byId("filtersView").style.display = "block";
  byId("scopeListManager").style.display = "block";
  __resetPopupSiteGroupsForTest();
  sendMessage.mockReset();
  sendMessage.mockImplementation((message: unknown) =>
    Promise.resolve(
      (message as { type: string }).type === "GET_SITE_GROUP_INDEX" ? INDEX : undefined
    )
  );
  onSubmit = vi.fn(() => Promise.resolve<EntrySubmitResult>({ ok: true }));
});

describe("one field with suggestions", () => {
  test("there is no type menu, and the field says 'Add another site'", () => {
    const doc = new DOMParser().parseFromString(HTML, "text/html");
    expect(doc.getElementById("scopeAddKind")).toBeNull();
    expect(doc.getElementById("siteLocationAddKind")).toBeNull();
    expect(doc.querySelector(".entry-kind-row")).toBeNull();
    for (const id of ["scopeAddInput", "siteLocationPatterns"]) {
      const field = doc.getElementById(id) as HTMLInputElement;
      expect(field.placeholder).toBe("Add another site");
      expect(field.getAttribute("data-i18n-placeholder")).toBe("filters_addAnother");
    }
  });

  test("the input is always an ARIA 1.2 combobox, closed until there's text", () => {
    create();
    expect(input().getAttribute("role")).toBe("combobox");
    expect(input().getAttribute("aria-autocomplete")).toBe("list");
    expect(input().getAttribute("aria-controls")).toBe("scopeGroupListbox");
    expect(input().getAttribute("aria-expanded")).toBe("false");
    input().focus();
    expect(listbox().hidden).toBe(true);
  });

  test("twitch.tv lists its readings, the Twitch group and Browse, with no row highlighted", async () => {
    create();
    type("twitch.tv");
    await indexLoaded();
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(listbox().hidden).toBe(false);
    expect(rows()).toEqual([
      "twitch.tv · Site and its subdomains",
      "twitch.tv · Exact address only",
      "*.twitch.tv · Subdomains only",
      "Twitch · Site group · 35 sites",
      "Browse all site groups…",
    ]);
    // Manual selection: nothing is active until an arrow key is pressed.
    expect(options().every((o) => o.getAttribute("aria-selected") === "false")).toBe(true);
    expect(listbox().querySelector(".active")).toBeNull();
    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
    // The v2fly credit shows with the group row.
    expect(attribution().hidden).toBe(false);
    expect(indexRequests()).toBe(1);
  });

  test("Enter adds the typed text, read by auto-detection", async () => {
    create();
    type("twitch.tv");
    await indexLoaded();
    const event = key("Enter");
    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledWith(["twitch.tv"], "site");
    expect(input().value).toBe("");
    expect(listbox().hidden).toBe(true);
  });

  test("arrow keys pick a reading: ArrowDown twice, then Enter, adds =twitch.tv", async () => {
    create();
    type("twitch.tv");
    await indexLoaded();
    key("ArrowDown");
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[0].id);
    expect(options()[0].getAttribute("aria-selected")).toBe("true");
    expect(options()[0].classList.contains("active")).toBe(true);
    key("ArrowDown");
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[1].id);
    expect(options()[0].getAttribute("aria-selected")).toBe("false");
    key("Enter");
    await flush();
    expect(onSubmit).toHaveBeenCalledWith(["=twitch.tv"], "exact");
  });

  test("ArrowUp wraps, and Home and End work while an option is active", async () => {
    create();
    type("twitch.tv");
    await indexLoaded();
    const active = () => input().getAttribute("aria-activedescendant");
    // Before an option is active, Home and End move the caret.
    expect(key("Home").defaultPrevented).toBe(false);
    key("ArrowUp");
    expect(active()).toBe(options()[4].id);
    key("ArrowDown");
    expect(active()).toBe(options()[0].id);
    expect(key("End").defaultPrevented).toBe(true);
    expect(active()).toBe(options()[4].id);
    key("Home");
    expect(active()).toBe(options()[0].id);
  });

  test("clicking the group row adds geosite:twitch, keeping focus in the input", async () => {
    create();
    type("twitch.tv");
    await indexLoaded();
    const option = optionByText("Twitch");
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    option.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    option.querySelector<HTMLElement>(".entry-suggestion-title")!.click();
    await flush();
    expect(onSubmit).toHaveBeenCalledWith(["geosite:twitch"], "group");
  });

  test("'Browse all site groups…' shows Popular and All site groups; typing goes back", async () => {
    create();
    type("twitch.tv");
    await indexLoaded();
    optionByText("Browse all site groups…").click();

    const groups = Array.from(listbox().querySelectorAll<HTMLElement>("[role='group']"));
    expect(groups.map((g) => byId(g.getAttribute("aria-labelledby")!).textContent)).toEqual([
      "Popular",
      "All site groups",
    ]);
    // Featured in table order (google, netflix, twitch), then the rest A-Z.
    expect(options().map((o) => o.querySelector(".entry-option-label")?.textContent)).toEqual([
      "Google · 964 sites",
      "Netflix · 40 sites",
      "Twitch · 35 sites",
      `category-ads-all · ${formatCount(6000)} sites`,
      "google-cn · 12 sites",
    ]);
    expect(options()[0].querySelector(".entry-option-secondary")?.textContent).toBe(
      "geosite:google"
    );
    expect(attribution().hidden).toBe(false);
    expect(input().hasAttribute("aria-activedescendant")).toBe(false);

    key("ArrowDown");
    key("ArrowDown");
    key("Enter");
    await flush();
    expect(onSubmit).toHaveBeenCalledWith(["geosite:netflix"], "group");

    type("twitch.tv");
    optionByText("Browse all site groups…").click();
    type("twitch.t");
    expect(listbox().querySelector("[role='group']")).toBeNull();
    expect(rows()[0]).toBe("twitch.t · Site and its subdomains");
  });

  test("Browse from the keyboard: ArrowUp to it, then Enter", async () => {
    create();
    type("twitch.tv");
    await indexLoaded();
    key("ArrowUp");
    key("Enter");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(listbox().querySelectorAll("[role='group']")).toHaveLength(2);
  });

  test("'google' + Enter names the fix and keeps the Google group to pick (K1)", async () => {
    create();
    input().focus();
    type("google");
    await indexLoaded();
    expect(rows()).toEqual([
      "Google · Site group · 964 sites",
      "google-cn · Site group · 12 sites",
      "Browse all site groups…",
    ]);
    key("Enter");
    await flush();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(errorShown()).toBe(true);
    expect(errorEl().getAttribute("role")).toBe("alert");
    expect(errorEl().textContent).toBe(ERROR_SITE_OR_GROUP);
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(listbox().hidden).toBe(false);
    expect(rows()[0]).toBe("Google · Site group · 964 sites");

    key("ArrowDown");
    key("Enter");
    await flush();
    expect(onSubmit).toHaveBeenCalledWith(["geosite:google"], "group");
  });

  test("the error shows between the field and the suggestions", () => {
    const doc = new DOMParser().parseFromString(HTML, "text/html");
    const box = doc.getElementById("scopeAddError")!.parentElement!;
    expect(box.classList.contains("entry-add-field")).toBe(true);
    expect(Array.from(box.children).map((c) => c.className)).toEqual([
      "scope-add-row",
      "scope-inline-msg",
      "entry-picker",
    ]);
  });

  test("Escape closes the suggestions without bubbling; a second Escape bubbles", async () => {
    create();
    type("twitch.tv");
    await indexLoaded();
    const outer = vi.fn();
    document.body.addEventListener("keydown", outer);
    const first = key("Escape");
    expect(first.defaultPrevented).toBe(true);
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(listbox().hidden).toBe(true);
    expect(attribution().hidden).toBe(true);
    expect(outer).not.toHaveBeenCalled();
    key("Escape");
    expect(outer).toHaveBeenCalledTimes(1);
    document.body.removeEventListener("keydown", outer);
  });

  test("ArrowDown reopens them", async () => {
    create();
    type("twitch.tv");
    await indexLoaded();
    key("Escape");
    key("ArrowDown");
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[0].id);
  });

  test("Tab and blur close them", async () => {
    create();
    input().focus();
    type("twitch.tv");
    await indexLoaded();
    key("Tab");
    expect(listbox().hidden).toBe(true);

    // Focus coming back with text reopens them.
    input().blur();
    input().focus();
    expect(listbox().hidden).toBe(false);
    input().blur();
    expect(listbox().hidden).toBe(true);
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  test.each(["=mail.example.com", "*.example.com", "https://example.com/list"])(
    "%s: a typed form with nothing to suggest leaves the listbox closed",
    async (value) => {
      create();
      type(value);
      await indexLoaded();
      if (value.startsWith("https://")) {
        // Not a list file, so it's a typed site: only the groups' Browse row.
        expect(rows()).toEqual(["Browse all site groups…"]);
      } else {
        expect(listbox().hidden).toBe(true);
      }
    }
  );

  test("the v2fly credit shows only while a site group is listed", async () => {
    create();
    type("example.org");
    await indexLoaded();
    expect(rows().map((r) => r.split(" · ")[1] ?? r)).toEqual([
      "Site and its subdomains",
      "Exact address only",
      "Subdomains only",
      "Browse all site groups…",
    ]);
    expect(attribution().hidden).toBe(true);
    type("goog");
    expect(attribution().hidden).toBe(false);
  });

  test("a typed group name that matches nothing says so", async () => {
    create();
    type("geosite:qqqq");
    await indexLoaded();
    expect(options()[0].getAttribute("aria-disabled")).toBe("true");
    expect(options()[0].textContent).toBe("No site groups match qqqq");
    expect(rows().slice(1)).toEqual(["Browse all site groups…"]);
    key("ArrowDown");
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[1].id);
  });

  test("a typed @tag carries over to the chosen group", async () => {
    create();
    type("goo@cn");
    await indexLoaded();
    expect(rows()[0]).toBe("Google @cn · Site group");
    key("ArrowDown");
    key("Enter");
    await flush();
    expect(onSubmit).toHaveBeenCalledWith(["geosite:google@cn"], "group");
  });

  test("Enter on an empty geosite: opens the full list", async () => {
    create();
    type("geosite:");
    await indexLoaded();
    key("Enter");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(listbox().querySelectorAll("[role='group']")).toHaveLength(2);
  });
});

describe("adding", () => {
  test.each<[string, string[], EntryInputKind]>([
    ["https://www.Example.com/path", ["https://www.example.com/path"], "site"],
    ["*.ru", ["*.ru"], "subdomains"],
    ["=Mail.Example.com", ["=mail.example.com"], "exact"],
    ["geosite:Google@CN", ["geosite:google@cn"], "group"],
    ["https://example.com/list.txt#x", ["list:https://example.com/list.txt"], "link"],
    ["list:https://example.com/rules", ["list:https://example.com/rules"], "link"],
  ])("%s adds %j as %s", async (value, entries, kind) => {
    create();
    // Set without an input event too: the kind is read again on Add.
    input().value = value;
    addButton().click();
    await flush();
    expect(onSubmit).toHaveBeenCalledWith(entries, kind);
    expect(input().value).toBe("");
    expect(errorShown()).toBe(false);
  });

  test.each<[string, string]>([
    ["nodot", ERROR_SITE_OR_GROUP],
    ["", ERROR_SITE_OR_GROUP],
    ["=*", "Enter one address, like mail.example.com, without *"],
    ["geosite:Bad Name", "No site group is called Bad Name."],
    ["list:http://example.com/list.txt", "Enter a link that starts with https://"],
  ])("%j shows %j and sends nothing", (value, message) => {
    create();
    input().value = value;
    addButton().click();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(errorShown()).toBe(true);
    expect(errorEl().getAttribute("role")).toBe("alert");
    expect(errorEl().textContent).toBe(message);
    expect(input().value).toBe(value);
    expect(input().getAttribute("aria-invalid")).toBe("true");

    type(`${value}x`);
    expect(errorShown()).toBe(false);
    expect(input().hasAttribute("aria-invalid")).toBe(false);
  });

  test("a refused add shows the returned message and keeps the text", async () => {
    onSubmit.mockResolvedValueOnce({ ok: false, message: "No site group is called googel." });
    create();
    type("geosite:googel");
    addButton().click();
    await flush();
    expect(errorEl().textContent).toBe("No site group is called googel.");
    expect(input().value).toBe("geosite:googel");
  });

  test("per-site: typed sites split on commas, read their own markers, and dedupe", async () => {
    create("siteLocation");
    type("a.com, *.b.com, =c.com, A.com");
    expect(listbox().hidden).toBe(true);
    addButton().click();
    await flush();
    expect(onSubmit).toHaveBeenCalledWith(["a.com", "*.b.com", "=c.com"], "site");
  });

  test("per-site: a path is refused with the per-site message", () => {
    create("siteLocation");
    type("a.com, example.com/app");
    addButton().click();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(errorEl().textContent).toBe("Use a site like example.com, with no path and not just *.");
  });

  test("per-site: a word that isn't a site closes the suggestions with the per-site message", async () => {
    create("siteLocation");
    type("google");
    await indexLoaded();
    key("Enter");
    expect(errorEl().textContent).toBe("Use a site like example.com, with no path and not just *.");
    expect(listbox().hidden).toBe(true);
  });

  test("readPending parses without adding", () => {
    const control = create("siteLocation");
    expect(control.readPending()).toBeNull();
    type("a.com, geosite:google");
    expect(control.readPending()).toEqual({ entries: ["a.com", "geosite:google"], error: null });
    type("a.com/x");
    expect(control.readPending()?.error).toBe(
      "Use a site like example.com, with no path and not just *."
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("reset clears the input, closes the suggestions and hides the error", async () => {
    const control = create();
    type("goo");
    await indexLoaded();
    key("Enter");
    expect(errorShown()).toBe(true);
    control.reset();
    expect(input().value).toBe("");
    expect(listbox().hidden).toBe(true);
    expect(errorShown()).toBe(false);
    expect(input().getAttribute("role")).toBe("combobox");
  });

  test("wires once: a second create for the same elements is the same control", async () => {
    const control = create();
    expect(create()).toBe(control);
    type("example.com");
    addButton().click();
    await flush();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("a list from a link", () => {
  test("shows 'Downloading list…' and disables the control while the add runs", async () => {
    let finish: (result: EntrySubmitResult) => void = () => {};
    onSubmit.mockImplementationOnce(
      () => new Promise<EntrySubmitResult>((resolve) => (finish = resolve))
    );
    create();
    type("https://example.com/list.txt");
    const name = describeEntry("list:https://example.com/list.txt", { unsaved: true }).title;
    expect(rows()).toEqual([`${name} · List from a link`]);
    addButton().click();
    await flush();

    expect(addButton().textContent).toBe("Downloading list…");
    expect(addButton().disabled).toBe(true);
    expect(input().disabled).toBe(true);
    expect(input().getAttribute("aria-busy")).toBe("true");
    expect(listbox().hidden).toBe(true);

    // A second press meanwhile does nothing.
    addButton().dispatchEvent(new MouseEvent("click"));
    expect(onSubmit).toHaveBeenCalledTimes(1);

    finish({ ok: true });
    await flush();
    expect(addButton().textContent).toBe("Add");
    expect(addButton().disabled).toBe(false);
    expect(input().disabled).toBe(false);
    expect(input().hasAttribute("aria-busy")).toBe(false);
    expect(input().value).toBe("");
  });

  test("picking the link's suggestion shows the busy label too", async () => {
    let finish: (result: EntrySubmitResult) => void = () => {};
    onSubmit.mockImplementationOnce(
      () => new Promise<EntrySubmitResult>((resolve) => (finish = resolve))
    );
    create();
    type("https://example.com/list.txt");
    key("ArrowDown");
    key("Enter");
    await flush();
    expect(onSubmit).toHaveBeenCalledWith(["list:https://example.com/list.txt"], "link");
    expect(addButton().textContent).toBe("Downloading list…");
    finish({ ok: true });
    await flush();
    expect(addButton().textContent).toBe("Add");
  });

  test("a failed download keeps the link and shows why", async () => {
    onSubmit.mockResolvedValueOnce({
      ok: false,
      message: "Couldn't download that list. Check the link and try again.",
    });
    create();
    type("https://example.com/list.txt");
    addButton().click();
    await flush();
    expect(input().value).toBe("https://example.com/list.txt");
    expect(errorEl().textContent).toBe(
      "Couldn't download that list. Check the link and try again."
    );
    expect(addButton().disabled).toBe(false);
  });

  test("other kinds don't show the busy state", async () => {
    let finish: (result: EntrySubmitResult) => void = () => {};
    onSubmit.mockImplementationOnce(
      () => new Promise<EntrySubmitResult>((resolve) => (finish = resolve))
    );
    create();
    type("geosite:google");
    addButton().click();
    await flush();
    expect(addButton().textContent).toBe("Add");
    expect(input().disabled).toBe(false);
    finish({ ok: true });
    await flush();
  });
});

describe("where site groups are unavailable (Safari)", () => {
  beforeEach(() => {
    gate.available = false;
  });

  test("twitch.tv suggests only the two typed readings, and asks for no index", async () => {
    create();
    type("twitch.tv");
    await indexLoaded();
    expect(rows()).toEqual([
      "twitch.tv · Site and its subdomains",
      "*.twitch.tv · Subdomains only",
    ]);
    expect(attribution().hidden).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();

    key("ArrowDown");
    key("ArrowDown");
    key("Enter");
    await flush();
    expect(onSubmit).toHaveBeenCalledWith(["*.twitch.tv"], "subdomains");
  });

  test.each([
    "geosite:google",
    "=a.com",
    "*.example.com",
    "https://example.com/list.txt",
    "google",
  ])("typing %s suggests nothing", (value) => {
    create();
    type(value);
    expect(listbox().hidden).toBe(true);
  });

  test("the new forms are refused with 'Use a site like example.com.'; typed ones still add", async () => {
    create();
    type("geosite:google");
    addButton().click();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(errorEl().textContent).toBe("Use a site like example.com.");

    type("*.ru");
    addButton().click();
    await flush();
    expect(onSubmit).toHaveBeenCalledWith(["*.ru"], "site");
  });

  test("per-site typed sites don't read the new markers either", () => {
    const control = create("siteLocation");
    type("a.com, =b.com");
    expect(control.readPending()?.error).toBe(
      "Use a site like example.com, with no path and not just *."
    );
  });
});
