/**
 * The shared add control (GeoSpoof/geospoof#206), against the real Filters
 * markup in assets/popup.html: the type menu, typing auto-detect, the site
 * group combobox, the link busy state, inline errors, and the Safari gate.
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
import { __resetPopupSiteGroupsForTest, formatCount } from "@/popup/site-groups";

const BODY = (() => {
  const html = readFileSync("assets/popup.html", "utf8");
  return new DOMParser().parseFromString(html, "text/html").body.innerHTML;
})();

const sendMessage = vi.mocked(browser.runtime.sendMessage);

const INDEX = {
  release: "20261104112839",
  lists: [
    { name: "category-ads-all", count: 6000 },
    { name: "google", count: 964 },
    { name: "google-cn", count: 12 },
    { name: "netflix", count: 40 },
    { name: "youtube", count: 178 },
  ],
};

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing`);
  return node as T;
}

const kindSelect = () => byId<HTMLSelectElement>("scopeAddKind");
const input = () => byId<HTMLInputElement>("scopeAddInput");
const addButton = () => byId<HTMLButtonElement>("scopeAddButton");
const listbox = () => byId("scopeGroupListbox");
const errorEl = () => byId("scopeAddError");

let onSubmit: ReturnType<
  typeof vi.fn<(entries: string[], kind: EntryInputKind) => Promise<EntrySubmitResult>>
>;

function create(context: "filters" | "siteLocation" = "filters"): EntryAddControl {
  const control = createEntryAddControl({
    ids: {
      kind: "scopeAddKind",
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

function pick(kind: EntryInputKind): void {
  kindSelect().value = kind;
  kindSelect().dispatchEvent(new Event("change"));
}

function key(name: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  input().dispatchEvent(event);
  return event;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function errorShown(): boolean {
  return errorEl().style.display === "block";
}

function options(): HTMLElement[] {
  return Array.from(listbox().querySelectorAll<HTMLElement>("[role='option']"));
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

describe("the type menu and auto-detect", () => {
  test("offers five kinds, starting at 'Site and its subdomains'", () => {
    create();
    expect(Array.from(kindSelect().options).map((o) => o.value)).toEqual([
      "site",
      "exact",
      "subdomains",
      "group",
      "link",
    ]);
    expect(kindSelect().value).toBe("site");
    expect(kindSelect().getAttribute("aria-label")).toBe("Type");
  });

  test.each<[string, EntryInputKind]>([
    ["geosite:google", "group"],
    ["GeoSite:Google@cn", "group"],
    ["*.example.com", "subdomains"],
    ["=a.com", "exact"],
    ["list:https://example.com/x", "link"],
    ["https://example.com/list.txt", "link"],
    ["https://example.com/rules.list", "link"],
    ["https://example.com/clash.conf", "link"],
    ["https://example.com/a/b.yaml", "link"],
    ["https://example.com/a/b.yml", "link"],
  ])("typing %s picks %s", (value, kind) => {
    create();
    type(value);
    expect(kindSelect().value).toBe(kind);
  });

  test.each(["https://example.com", "https://example.com/app/*", "example.com", "site.com/app/*"])(
    "%s stays a typed site",
    (value) => {
      create();
      type(value);
      expect(kindSelect().value).toBe("site");
    }
  );

  test("removing the marker puts an auto-picked kind back", () => {
    create();
    type("*.example.com");
    expect(kindSelect().value).toBe("subdomains");
    type("example.com");
    expect(kindSelect().value).toBe("site");
  });

  test("never overrides a kind the user picked", () => {
    create();
    pick("exact");
    type("geosite:google");
    expect(kindSelect().value).toBe("exact");
    type("*.example.com");
    expect(kindSelect().value).toBe("exact");
  });

  test("picking a kind rewrites the input without markers that ask for another", () => {
    create();
    type("=mail.example.com");
    pick("site");
    expect(input().value).toBe("mail.example.com");
    type("geosite:google");
    pick("exact");
    expect(input().value).toBe("google");
  });

  test("each kind has its own placeholder", () => {
    create();
    const placeholders = (["site", "exact", "subdomains", "group", "link"] as const).map((kind) => {
      pick(kind);
      return input().placeholder;
    });
    expect(placeholders).toEqual([
      "example.com, *.ru, site.com/app/*",
      "mail.example.com",
      "example.com",
      "Search site groups, e.g. Google",
      "https://example.com/list.txt",
    ]);
  });
});

describe("adding", () => {
  test.each<[string, EntryInputKind | null, string[], EntryInputKind]>([
    ["https://www.Example.com/path", null, ["https://www.example.com/path"], "site"],
    ["*.ru", null, ["*.ru"], "subdomains"],
    ["=Mail.Example.com", null, ["=mail.example.com"], "exact"],
    ["geosite:Google@CN", null, ["geosite:google@cn"], "group"],
    ["https://example.com/list.txt#x", null, ["list:https://example.com/list.txt"], "link"],
    ["example.com", "subdomains", ["*.example.com"], "subdomains"],
    ["mail.example.com", "exact", ["=mail.example.com"], "exact"],
    ["netflix", "group", ["geosite:netflix"], "group"],
    ["https://example.com/rules", "link", ["list:https://example.com/rules"], "link"],
  ])("%s (picked: %s) adds %j", async (value, picked, entries, kind) => {
    create();
    if (picked) pick(picked);
    // Set without an input event too: the kind is read again on Add.
    input().value = value;
    addButton().click();
    await flush();
    expect(onSubmit).toHaveBeenCalledWith(entries, kind);
    expect(input().value).toBe("");
    expect(errorShown()).toBe(false);
  });

  test("Enter adds", async () => {
    create();
    type("example.com");
    const event = key("Enter");
    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledWith(["example.com"], "site");
  });

  test("after adding, an auto-picked kind returns to the default; a picked one stays", async () => {
    create();
    type("=a.com");
    addButton().click();
    await flush();
    expect(kindSelect().value).toBe("site");

    pick("exact");
    type("b.com");
    addButton().click();
    await flush();
    expect(kindSelect().value).toBe("exact");
  });

  test.each<[string, EntryInputKind | null, string]>([
    ["nodot", null, "Not a valid pattern"],
    ["", null, "Not a valid pattern"],
    ["*", "exact", "Enter one address, like mail.example.com, without *"],
    ["geosite:Bad Name", null, "No site group is called Bad Name."],
    ["http://example.com/list.txt", "link", "Enter a link that starts with https://"],
  ])("%j (picked: %s) shows %j and sends nothing", (value, picked, message) => {
    create();
    if (picked) pick(picked);
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

  test("reset clears the input and the picked kind", () => {
    const control = create();
    pick("group");
    type("goo");
    control.reset();
    expect(input().value).toBe("");
    expect(kindSelect().value).toBe("site");
    expect(input().hasAttribute("role")).toBe(false);
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

describe("the site group combobox", () => {
  async function openPicker(): Promise<void> {
    create();
    pick("group");
    input().focus();
    // The index loads on first open.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  test("is an ARIA 1.2 combobox only while the kind is Site group", async () => {
    create();
    expect(input().hasAttribute("role")).toBe(false);
    pick("group");
    expect(input().getAttribute("role")).toBe("combobox");
    expect(input().getAttribute("aria-autocomplete")).toBe("list");
    expect(input().getAttribute("aria-controls")).toBe("scopeGroupListbox");
    expect(input().getAttribute("aria-expanded")).toBe("false");
    pick("site");
    for (const attr of ["role", "aria-autocomplete", "aria-controls", "aria-expanded"]) {
      expect(input().hasAttribute(attr)).toBe(false);
    }
    await flush();
  });

  test("focus opens it with Popular first, then All site groups, and the attribution", async () => {
    await openPicker();
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(listbox().hidden).toBe(false);
    expect(listbox().getAttribute("role")).toBe("listbox");
    expect(listbox().getAttribute("aria-label")).toBe("Site groups");
    expect(byId("scopeGroupAttribution").hidden).toBe(false);
    expect(byId("scopeGroupAttribution").textContent?.trim()).toBe(
      "Site groups come from the v2fly domain list (MIT license)."
    );

    const groups = Array.from(listbox().querySelectorAll<HTMLElement>("[role='group']"));
    expect(groups.map((g) => byId(g.getAttribute("aria-labelledby")!).textContent)).toEqual([
      "Popular",
      "All site groups",
    ]);
    // Featured in table order (google, youtube, netflix), then the rest A-Z.
    expect(options().map((o) => o.querySelector(".entry-option-label")?.textContent)).toEqual([
      "Google · 964 sites",
      "YouTube · 178 sites",
      "Netflix · 40 sites",
      `category-ads-all · ${formatCount(6000)} sites`,
      "google-cn · 12 sites",
    ]);
    expect(options()[0].querySelector(".entry-option-secondary")?.textContent).toBe(
      "geosite:google"
    );
    expect(options()[3].querySelector(".entry-option-secondary")).toBeNull();
    expect(options().every((o) => o.getAttribute("aria-selected") === "false")).toBe(true);
    expect(sendMessage.mock.calls.map(([m]) => (m as unknown as { type: string }).type)).toEqual([
      "GET_SITE_GROUP_INDEX",
    ]);
  });

  test("arrow keys, Home and End move the active option", async () => {
    await openPicker();
    const active = () => input().getAttribute("aria-activedescendant");

    key("ArrowDown");
    expect(active()).toBe(options()[0].id);
    expect(options()[0].getAttribute("aria-selected")).toBe("true");
    expect(options()[0].classList.contains("active")).toBe(true);

    key("ArrowDown");
    expect(active()).toBe(options()[1].id);
    expect(options()[0].getAttribute("aria-selected")).toBe("false");

    key("ArrowUp");
    expect(active()).toBe(options()[0].id);
    key("ArrowUp");
    expect(active()).toBe(options()[4].id);

    expect(key("Home").defaultPrevented).toBe(true);
    expect(active()).toBe(options()[0].id);
    key("End");
    expect(active()).toBe(options()[4].id);
  });

  test("Enter adds the active option", async () => {
    await openPicker();
    key("ArrowDown");
    key("ArrowDown");
    key("Enter");
    await flush();
    expect(onSubmit).toHaveBeenCalledWith(["geosite:youtube"], "group");
    expect(input().value).toBe("");
    expect(listbox().hidden).toBe(true);
  });

  test("typing searches; a typed @tag carries over to the chosen group", async () => {
    await openPicker();
    type("goo@cn");
    expect(options().map((o) => o.querySelector(".entry-option-label")?.textContent)).toEqual([
      "Google · 964 sites",
      "google-cn · 12 sites",
    ]);
    key("ArrowDown");
    key("Enter");
    await flush();
    expect(onSubmit).toHaveBeenCalledWith(["geosite:google@cn"], "group");
  });

  test("Enter with no active option adds the typed geosite:name@tag", async () => {
    await openPicker();
    type("geosite:Netflix@US");
    key("Enter");
    await flush();
    expect(onSubmit).toHaveBeenCalledWith(["geosite:netflix@us"], "group");
  });

  test("a click adds the option, keeping focus in the input", async () => {
    await openPicker();
    const option = options()[2];
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    option.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    option.querySelector<HTMLElement>(".entry-option-label")!.click();
    await flush();
    expect(onSubmit).toHaveBeenCalledWith(["geosite:netflix"], "group");
  });

  test("Escape closes it without bubbling; a second Escape bubbles", async () => {
    await openPicker();
    const outer = vi.fn();
    document.body.addEventListener("keydown", outer);
    const first = key("Escape");
    expect(first.defaultPrevented).toBe(true);
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(listbox().hidden).toBe(true);
    expect(byId("scopeGroupAttribution").hidden).toBe(true);
    expect(outer).not.toHaveBeenCalled();
    key("Escape");
    expect(outer).toHaveBeenCalledTimes(1);
    document.body.removeEventListener("keydown", outer);
  });

  test("ArrowDown reopens it", async () => {
    await openPicker();
    key("Escape");
    key("ArrowDown");
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[0].id);
  });

  test("says when nothing matches", async () => {
    await openPicker();
    type("qqqq");
    expect(options()).toHaveLength(1);
    expect(options()[0].getAttribute("aria-disabled")).toBe("true");
    expect(options()[0].textContent).toBe("No site groups match qqqq");
    key("ArrowDown");
    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
  });

  test("blur closes it", async () => {
    await openPicker();
    input().blur();
    expect(listbox().hidden).toBe(true);
    expect(input().getAttribute("aria-expanded")).toBe("false");
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
    addButton().click();
    await flush();

    expect(addButton().textContent).toBe("Downloading list…");
    expect(addButton().disabled).toBe(true);
    expect(input().disabled).toBe(true);
    expect(kindSelect().disabled).toBe(true);
    expect(input().getAttribute("aria-busy")).toBe("true");

    // A second press meanwhile does nothing.
    addButton().dispatchEvent(new MouseEvent("click"));
    expect(onSubmit).toHaveBeenCalledTimes(1);

    finish({ ok: true });
    await flush();
    expect(addButton().textContent).toBe("Add");
    expect(addButton().disabled).toBe(false);
    expect(input().disabled).toBe(false);
    expect(kindSelect().disabled).toBe(false);
    expect(input().hasAttribute("aria-busy")).toBe(false);
    expect(input().value).toBe("");
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

  test("the exact, group and link kinds are not offered", () => {
    create();
    expect(Array.from(kindSelect().options).map((o) => o.value)).toEqual(["site", "subdomains"]);
  });

  test.each(["geosite:google", "=a.com", "*.example.com", "https://example.com/list.txt"])(
    "typing %s picks nothing",
    (value) => {
      create();
      type(value);
      expect(kindSelect().value).toBe("site");
      expect(input().hasAttribute("role")).toBe(false);
    }
  );

  test("the new forms are refused as typed patterns; typed ones still add", async () => {
    create();
    type("geosite:google");
    addButton().click();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(errorEl().textContent).toBe("Not a valid pattern");

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
