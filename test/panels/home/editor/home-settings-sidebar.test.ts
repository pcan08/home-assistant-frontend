import { afterEach, describe, expect, it, vi } from "vitest";
import "../../../../src/panels/home/editor/home-settings-sidebar";
import type { HomeSettingsSidebar } from "../../../../src/panels/home/editor/home-settings-sidebar";
import { createMockHass } from "../../../fixtures/hass";

// Web Awesome buttons need form internals jsdom lacks. The handlers under
// test are on the host elements, so plain stand-ins are enough.
vi.mock("../../../../src/components/ha-button", () => ({}));
vi.mock("../../../../src/components/ha-icon-button", () => ({}));
for (const tag of ["ha-button", "ha-icon-button"]) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends HTMLElement {});
  }
}

// jsdom has no Web Animations: the side panel's slide is done at once.
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
const createSidebar = async (props: Partial<HomeSettingsSidebar> = {}) => {
  const el = document.createElement("home-settings-sidebar");
  (el as unknown as Record<"_i18n", unknown>)._i18n = createMockHass();
  Object.assign(el, props);
  const cancel = vi.fn();
  el.addEventListener("home-settings-cancel", cancel);
  document.body.append(el);
  await el.updateComplete;
  return { el, cancel };
};

const pressEscape = (el: HomeSettingsSidebar) =>
  el
    .shadowRoot!.querySelector(".container")!
    .dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    );

const closeButton = (el: HomeSettingsSidebar) =>
  el.shadowRoot!.querySelector("ha-icon-button") as HTMLElement;

describe("home-settings-sidebar", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("closes on Escape when the draft has no changes", async () => {
    const { el, cancel } = await createSidebar();
    pressEscape(el);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("keeps unsaved changes on Escape, but closes from the close button", async () => {
    const { el, cancel } = await createSidebar({ dirty: true });
    pressEscape(el);
    expect(cancel).not.toHaveBeenCalled();

    closeButton(el).click();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not close in any way while saving", async () => {
    const { el, cancel } = await createSidebar({
      narrow: true,
      submitting: true,
    });
    pressEscape(el);
    closeButton(el).click();
    el.shadowRoot!.querySelector("ha-snap-bottom-sheet")!.dispatchEvent(
      new Event("bottom-sheet-closed")
    );
    expect(cancel).not.toHaveBeenCalled();
  });

  it("only lets the bottom sheet be swiped away without unsaved changes or a save", async () => {
    const { el } = await createSidebar({ narrow: true });
    const sheet = () => el.shadowRoot!.querySelector("ha-snap-bottom-sheet")!;
    expect(sheet().dismissable).toBe(true);

    el.dirty = true;
    await el.updateComplete;
    expect(sheet().dismissable).toBe(false);

    el.dirty = false;
    el.submitting = true;
    await el.updateComplete;
    expect(sheet().dismissable).toBe(false);
  });

  it("reports the end of the slide out, not of a slide in it cancelled", async () => {
    const slide = () => {
      let settle!: () => void;
      const finished = new Promise<void>((resolve) => {
        settle = resolve;
      });
      return { finished, settle };
    };
    const slideIn = slide();
    const slideOut = slide();
    const getAnimations = vi
      .spyOn(Element.prototype, "getAnimations")
      .mockReturnValue([slideIn] as unknown as Animation[]);
    const transitions: boolean[] = [];
    const onTransition = (ev: Event) =>
      transitions.push((ev as CustomEvent<{ active: boolean }>).detail.active);
    window.addEventListener("hass-layout-transition", onTransition);
    try {
      const { el } = await createSidebar();
      const closed = vi.fn();
      el.addEventListener("home-settings-closed", closed);

      // Closed before the slide in is over: the slide out cancels it.
      getAnimations.mockReturnValue([slideOut] as unknown as Animation[]);
      el.closing = true;
      await el.updateComplete;
      slideIn.settle();
      await Promise.resolve();
      await Promise.resolve();
      expect(closed).not.toHaveBeenCalled();
      expect(transitions).toEqual([true]);

      slideOut.settle();
      await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
      expect(transitions).toEqual([true, false]);
    } finally {
      window.removeEventListener("hass-layout-transition", onTransition);
      getAnimations.mockRestore();
    }
  });
});
