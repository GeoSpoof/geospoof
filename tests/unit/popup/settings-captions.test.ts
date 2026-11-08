/**
 * Card captions: one per card, by precedence (error, then an open ⓘ, then the
 * standing caption), with one ⓘ open per card and a truthful aria-expanded.
 */
import { describe, test, expect, beforeEach } from "vitest";
import {
  pickCaption,
  renderCaptionGroup,
  setCaptionActive,
  wireInfoButtons,
  __resetCaptionsForTest,
} from "@/popup/settings-captions";

describe("pickCaption", () => {
  test("an error outranks an open ⓘ, which outranks the standing caption", () => {
    expect(
      pickCaption([
        { kind: "standing", eligible: true },
        { kind: "info", eligible: true },
        { kind: "error", eligible: true },
      ])
    ).toBe(2);
    expect(
      pickCaption([
        { kind: "standing", eligible: true },
        { kind: "info", eligible: true },
        { kind: "error", eligible: false },
      ])
    ).toBe(1);
    expect(
      pickCaption([
        { kind: "standing", eligible: true },
        { kind: "info", eligible: false },
      ])
    ).toBe(0);
  });

  test("markup order breaks ties", () => {
    expect(
      pickCaption([
        { kind: "standing", eligible: true },
        { kind: "standing", eligible: true },
      ])
    ).toBe(0);
  });

  test("-1 when nothing is eligible", () => {
    expect(pickCaption([])).toBe(-1);
    expect(pickCaption([{ kind: "error", eligible: false }])).toBe(-1);
  });
});

describe("caption groups in the DOM", () => {
  beforeEach(() => {
    __resetCaptionsForTest();
    document.body.innerHTML = `
      <div id="advancedContent">
        <div class="toggle-group">
          <button type="button" class="info-icon" id="aInfo" aria-expanded="false" aria-controls="aTip">ⓘ</button>
          <button type="button" class="info-icon" id="bInfo" aria-expanded="false" aria-controls="bTip">ⓘ</button>
        </div>
        <div id="captions" data-caption-group>
          <p id="err" data-caption="error" hidden>Error</p>
          <p id="aTip" data-caption="info" hidden>A</p>
          <p id="bTip" data-caption="info" hidden>B</p>
          <p id="warn" data-caption="standing" data-active="false" hidden>Warning</p>
          <p id="hint" data-caption="standing">Hint</p>
        </div>
        <p id="elsewhere">Elsewhere</p>
      </div>`;
    wireInfoButtons(document.getElementById("advancedContent"));
  });

  const shown = () =>
    Array.from(document.getElementById("captions")!.children)
      .filter((el) => !(el as HTMLElement).hidden)
      .map((el) => el.id);
  const a = () => document.getElementById("aInfo")!;
  const b = () => document.getElementById("bInfo")!;

  test("the standing caption shows by default", () => {
    expect(shown()).toEqual(["hint"]);
  });

  test("an active standing caption listed first wins the tie", () => {
    setCaptionActive(document.getElementById("warn"), true);
    expect(shown()).toEqual(["warn"]);
  });

  test("opening an ⓘ replaces the standing caption; closing it brings it back", () => {
    a().click();
    expect(a().getAttribute("aria-expanded")).toBe("true");
    expect(shown()).toEqual(["aTip"]);
    a().click();
    expect(a().getAttribute("aria-expanded")).toBe("false");
    expect(shown()).toEqual(["hint"]);
  });

  test("opening one ⓘ closes the other in the same card", () => {
    a().click();
    b().click();
    expect(a().getAttribute("aria-expanded")).toBe("false");
    expect(b().getAttribute("aria-expanded")).toBe("true");
    expect(shown()).toEqual(["bTip"]);
  });

  test("a click elsewhere closes the open ⓘ", () => {
    a().click();
    document.getElementById("elsewhere")!.click();
    expect(a().getAttribute("aria-expanded")).toBe("false");
    expect(shown()).toEqual(["hint"]);
  });

  test("an active error hides an open ⓘ and sets its aria-expanded to false", () => {
    a().click();
    setCaptionActive(document.getElementById("err"), true);
    expect(shown()).toEqual(["err"]);
    expect(a().getAttribute("aria-expanded")).toBe("false");
    setCaptionActive(document.getElementById("err"), false);
    expect(shown()).toEqual(["hint"]);
  });

  test("rendering is idempotent", () => {
    const group = document.getElementById("captions")!;
    renderCaptionGroup(group);
    renderCaptionGroup(group);
    expect(shown()).toEqual(["hint"]);
  });
});
