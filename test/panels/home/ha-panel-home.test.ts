import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as FrontendDataModule from "../../../src/data/frontend";
import type { HomeFrontendSystemData } from "../../../src/data/frontend";
import type * as GetStrategyModule from "../../../src/panels/lovelace/strategies/get-strategy";
import type { HomeAssistant } from "../../../src/types";
import { provideHass } from "../../../src/fake_data/provide_hass";
import { createMockHass } from "../../fixtures/hass";
import "../../../src/panels/home/ha-panel-home";
import { saveFrontendSystemData } from "../../../src/data/frontend";
import { resolveShortcutItems } from "../../../src/data/home_shortcuts";
import type { HomeConfigDraftSession } from "../../../src/panels/home/editor/home-config-draft-session";
import type { EditorState } from "../../../src/panels/home/editor/home-config-editor-state";
import { generateLovelaceDashboardStrategy } from "../../../src/panels/lovelace/strategies/get-strategy";

// ha-panel-home transitively imports theme resources that reference
// __STATIC_PATH__, a build-time global normally injected by the bundler.
vi.hoisted(() => {
  (globalThis as any).__STATIC_PATH__ = "/static/";
});

type HomePanel = HTMLElement & {
  hass: unknown;
  updateComplete: Promise<boolean>;
  _showBanner: boolean;
  _loadConfigPromise?: Promise<void>;
  [key: string]: unknown;
};

for (const tag of ["ha-button", "ha-svg-icon", "home-settings-form"]) {
  if (!customElements.get(tag)) {
    customElements.define(tag, class extends HTMLElement {});
  }
}
// jsdom has no Web Animations: the side panel's slide is done at once.
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe = vi.fn();

    unobserve = vi.fn();

    disconnect = vi.fn();
  }
);
vi.mock("../../../src/components/ha-button", () => ({}));
vi.mock("../../../src/components/ha-svg-icon", () => ({}));
vi.mock("../../../src/panels/lovelace/hui-root", () => ({}));
// The form's own behavior is not under test here, only what it receives.
vi.mock("../../../src/panels/home/editor/home-settings-form", () => ({}));
vi.mock("../../../src/panels/home/dialogs/show-dialog-new-overview", () => ({
  showNewOverviewDialog: vi.fn(),
}));

vi.mock(
  "../../../src/panels/lovelace/strategies/get-strategy",
  async (importOriginal) => {
    const actual = await importOriginal<typeof GetStrategyModule>();
    return {
      ...actual,
      generateLovelaceDashboardStrategy: vi.fn(),
    };
  }
);

vi.mock("../../../src/data/frontend", async (importOriginal) => {
  const actual = await importOriginal<typeof FrontendDataModule>();
  return {
    ...actual,
    fetchFrontendSystemData: vi.fn(),
    saveFrontendSystemData: vi.fn(),
    subscribeFrontendSystemData: vi.fn(() => () => undefined),
  };
});
const mockedGenerateLovelaceDashboardStrategy = vi.mocked(
  generateLovelaceDashboardStrategy
);

const mockedSaveFrontendSystemData = vi.mocked(saveFrontendSystemData);

interface TestPanelHome extends HTMLElement {
  hass: HomeAssistant;
  hasUpdated: boolean;
  _lovelace?: { config: unknown };
  willUpdate(changedProps: Map<string, unknown>): void;
}

type Private = Record<string, any>;

const priv = (el: TestPanelHome) => el as unknown as Private;

const setLovelace = (el: TestPanelHome): Promise<void> =>
  priv(el)._setLovelace();

const editHome = (el: TestPanelHome) => priv(el)._editHome();

const changeDraft = (el: TestPanelHome, patch: Partial<EditorState>) =>
  priv(el)._settingsChanged(
    new CustomEvent("value-changed", {
      detail: { value: { ...priv(el)._session.draft, ...patch } },
    })
  );

const cancelSettings = (el: TestPanelHome) => priv(el)._cancelSettings();

const saveSettings = (el: TestPanelHome): Promise<void> =>
  priv(el)._saveSettings();

const session = (el: TestPanelHome): HomeConfigDraftSession | undefined =>
  priv(el)._session;

const homeStrategy = (config: HomeFrontendSystemData) => ({
  strategy: {
    type: "home",
    alert_entities: undefined,
    favorite_entities: config.favorite_entities,
    home_panel: true,
    hide_welcome_message: config.hide_welcome_message,
    hide_suggested_entities: config.hide_suggested_entities,
    shortcuts: config.shortcuts,
  },
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("ha-panel-home settings editing", () => {
  beforeEach(() => {
    // Draft edits schedule a real 200ms debounce. Fake timers keep it from
    // firing on its own, so each test decides when it runs.
    vi.useFakeTimers();
    mockedGenerateLovelaceDashboardStrategy.mockReset();
    mockedGenerateLovelaceDashboardStrategy.mockResolvedValue({
      views: [],
    } as any);
    mockedSaveFrontendSystemData.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const createPanel = (config: HomeFrontendSystemData = {}) => {
    const el = document.createElement(
      "ha-panel-home"
    ) as unknown as TestPanelHome;
    el.hass = createMockHass();
    priv(el)._config = config;
    return el;
  };

  it("keeps the most recently started regeneration when an older one resolves later", async () => {
    const el = createPanel();

    const older = deferred<{ views: unknown[] }>();
    const newer = deferred<{ views: unknown[] }>();
    mockedGenerateLovelaceDashboardStrategy
      .mockReturnValueOnce(older.promise as any)
      .mockReturnValueOnce(newer.promise as any);

    // Two regenerations start back-to-back, simulating two _setLovelace()
    // calls overlapping in flight.
    const olderCall = setLovelace(el);
    const newerCall = setLovelace(el);

    // The newer one resolves first...
    newer.resolve({ views: ["newer"] });
    await newerCall;
    // ...but the older one, from before it, resolves last.
    older.resolve({ views: ["older"] });
    await olderCall;

    expect(el._lovelace?.config).toEqual({ views: ["newer"] });
  });

  it("does not regenerate when the settings open", async () => {
    const el = createPanel();
    editHome(el);

    await vi.advanceTimersByTimeAsync(200);
    expect(mockedGenerateLovelaceDashboardStrategy).not.toHaveBeenCalled();
  });

  it("previews each draft edit once, after the debounce", async () => {
    const el = createPanel();
    editHome(el);

    changeDraft(el, { show_welcome_message: false });
    expect(mockedGenerateLovelaceDashboardStrategy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(mockedGenerateLovelaceDashboardStrategy).toHaveBeenCalledTimes(1);
    expect(mockedGenerateLovelaceDashboardStrategy).toHaveBeenLastCalledWith(
      homeStrategy({ hide_welcome_message: true }),
      el.hass
    );
  });

  it("ignores an edit that does not change the draft's meaning", async () => {
    const el = createPanel();
    editHome(el);

    // The shortcuts editor emits the full resolved list on its first change,
    // which means the same as no stored shortcuts.
    changeDraft(el, { shortcuts: resolveShortcutItems([]) });

    expect(session(el)!.generation).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(mockedGenerateLovelaceDashboardStrategy).not.toHaveBeenCalled();
  });

  it("goes back to the saved config when closing after an edit undone", async () => {
    const saved: HomeFrontendSystemData = { favorite_entities: ["light.a"] };
    const el = createPanel(saved);
    editHome(el);
    changeDraft(el, { favorite_entities: ["light.a", "light.b"] });
    changeDraft(el, { favorite_entities: ["light.a"] });
    await vi.advanceTimersByTimeAsync(200);
    mockedGenerateLovelaceDashboardStrategy.mockClear();

    cancelSettings(el);
    await vi.advanceTimersByTimeAsync(200);

    expect(session(el)).toBeUndefined();
    expect(mockedGenerateLovelaceDashboardStrategy).toHaveBeenCalledTimes(1);
    expect(mockedGenerateLovelaceDashboardStrategy).toHaveBeenLastCalledWith(
      homeStrategy(saved),
      el.hass
    );
  });

  it("regenerates once from the saved config on cancel after an edit", async () => {
    const el = createPanel();
    editHome(el);
    changeDraft(el, { show_welcome_message: false });

    // Cancelled before the edit's debounced regeneration fires
    cancelSettings(el);
    await vi.advanceTimersByTimeAsync(200);

    expect(mockedGenerateLovelaceDashboardStrategy).toHaveBeenCalledTimes(1);
    expect(mockedGenerateLovelaceDashboardStrategy).toHaveBeenLastCalledWith(
      homeStrategy({}),
      el.hass
    );
  });

  it("does not regenerate on cancel without any edit", async () => {
    const el = createPanel();
    editHome(el);

    cancelSettings(el);
    await vi.advanceTimersByTimeAsync(200);

    expect(session(el)).toBeUndefined();
    expect(mockedGenerateLovelaceDashboardStrategy).not.toHaveBeenCalled();
  });

  it("discards a draft regeneration that resolves after cancel", async () => {
    const el = createPanel();

    const draftGeneration = deferred<{ views: unknown[] }>();
    mockedGenerateLovelaceDashboardStrategy.mockReturnValueOnce(
      draftGeneration.promise as any
    );

    editHome(el);
    changeDraft(el, { show_welcome_message: false });
    // The edit's regeneration starts and takes a while.
    await vi.advanceTimersByTimeAsync(200);

    cancelSettings(el);
    await vi.advanceTimersByTimeAsync(0);
    expect(el._lovelace?.config).toEqual({ views: [] });

    // The cancelled draft's result comes back last.
    draftGeneration.resolve({ views: ["draft"] });
    await vi.advanceTimersByTimeAsync(0);

    expect(el._lovelace?.config).toEqual({ views: [] });
  });

  it("never applies an earlier draft's regeneration once the draft changed again", async () => {
    const el = createPanel();

    const firstDraft = deferred<{ views: unknown[] }>();
    mockedGenerateLovelaceDashboardStrategy.mockReturnValueOnce(
      firstDraft.promise as any
    );

    editHome(el);
    changeDraft(el, { show_welcome_message: false });
    await vi.advanceTimersByTimeAsync(200);

    // A second edit, before the first one's regeneration resolves
    changeDraft(el, { show_suggested_entities: false });
    firstDraft.resolve({ views: ["first draft"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(el._lovelace).toBeUndefined();

    await vi.advanceTimersByTimeAsync(200);
    expect(el._lovelace?.config).toEqual({ views: [] });
  });

  it("saves the draft, closes and regenerates only once", async () => {
    const el = createPanel({ welcome_banner_dismissed: true });
    mockedSaveFrontendSystemData.mockResolvedValueOnce(undefined);
    editHome(el);
    // Saved before the edit's debounced regeneration fires
    changeDraft(el, { show_welcome_message: false });

    await saveSettings(el);
    await vi.advanceTimersByTimeAsync(200);

    const expected = {
      welcome_banner_dismissed: true,
      hide_welcome_message: true,
    };
    expect(mockedSaveFrontendSystemData).toHaveBeenCalledTimes(1);
    expect(mockedSaveFrontendSystemData.mock.calls[0][2]).toEqual(
      expect.objectContaining(expected)
    );
    expect(priv(el)._config).toEqual(expect.objectContaining(expected));
    expect(session(el)).toBeUndefined();
    expect(priv(el)._submitting).toBe(false);
    expect(mockedGenerateLovelaceDashboardStrategy).toHaveBeenCalledTimes(1);
    expect(mockedGenerateLovelaceDashboardStrategy).toHaveBeenLastCalledWith(
      homeStrategy({ hide_welcome_message: true }),
      el.hass
    );
  });

  it("stays open with the draft intact when the save fails", async () => {
    const el = createPanel();
    mockedSaveFrontendSystemData.mockRejectedValueOnce(new Error("boom"));
    editHome(el);
    changeDraft(el, { show_welcome_message: false });
    const before = session(el);

    await saveSettings(el);

    expect(session(el)).toBe(before);
    expect(session(el)!.draft.show_welcome_message).toBe(false);
    expect(priv(el)._submitting).toBe(false);
    expect(priv(el)._config).toEqual({});
  });

  it("refuses to cancel, edit or save again while a save is in flight", async () => {
    const el = createPanel();
    const pending = deferred<undefined>();
    mockedSaveFrontendSystemData.mockReturnValueOnce(pending.promise as any);
    editHome(el);
    changeDraft(el, { show_welcome_message: false });
    const before = session(el);

    const saving = saveSettings(el);
    expect(priv(el)._submitting).toBe(true);

    cancelSettings(el);
    changeDraft(el, { show_suggested_entities: false });
    await saveSettings(el);

    expect(session(el)).toBe(before);
    expect(mockedSaveFrontendSystemData).toHaveBeenCalledTimes(1);

    pending.resolve(undefined);
    await saving;
    expect(session(el)).toBeUndefined();
  });

  it("does not let a save close a later session", async () => {
    const el = createPanel();
    const pending = deferred<undefined>();
    mockedSaveFrontendSystemData.mockReturnValueOnce(pending.promise as any);
    editHome(el);
    changeDraft(el, { show_welcome_message: false });
    const saving = saveSettings(el);

    // Leaving the page drops the session even during the save...
    priv(el)._closeSettings();
    // ...but the settings cannot open again until the save is done.
    editHome(el);
    expect(session(el)).toBeUndefined();

    pending.resolve(undefined);
    await saving;
    editHome(el);
    expect(session(el)).toBeDefined();
    expect(priv(el)._config).toEqual(
      expect.objectContaining({ hide_welcome_message: true })
    );
  });

  it("cancels a pending draft debounce before a locale-driven regeneration", async () => {
    const el = createPanel();
    (el as unknown as Record<"hasUpdated", boolean>).hasUpdated = true;
    editHome(el);

    // An edit schedules the 200ms debounce...
    changeDraft(el, { show_welcome_message: false });

    // ...but the locale changes before it fires.
    const oldHass = el.hass;
    el.hass = { ...oldHass, localize: ((key: string) => key) as any };
    el.willUpdate(new Map([["hass", oldHass]]));

    expect(mockedGenerateLovelaceDashboardStrategy).toHaveBeenCalledTimes(1);

    // Advancing past the debounce's original window must not add a second,
    // now-redundant regeneration.
    await vi.advanceTimersByTimeAsync(200);
    expect(mockedGenerateLovelaceDashboardStrategy).toHaveBeenCalledTimes(1);
  });

  it("drops the draft when the route changes", async () => {
    const el = createPanel();
    (el as unknown as Record<"hasUpdated", boolean>).hasUpdated = true;
    const route = { prefix: "/home", path: "/overview" };
    (el as unknown as Private).route = route;
    editHome(el);
    changeDraft(el, { show_welcome_message: false });

    (el as unknown as Private).route = { prefix: "/home", path: "/areas-x" };
    el.willUpdate(new Map<string, unknown>([["route", route]]));

    expect(session(el)).toBeUndefined();
  });
});

const STORED: HomeFrontendSystemData = {
  welcome_banner_dismissed: false,
  favorite_entities: ["light.kitchen", "climate.living"],
  shortcuts: [
    { type: "summary", key: "light" },
    { type: "custom", path: "/energy", label: "Energy" },
  ],
};

const openPanel = async (fetchImpl: () => Promise<any>) => {
  const { fetchFrontendSystemData } =
    await import("../../../src/data/frontend");
  vi.mocked(fetchFrontendSystemData).mockImplementation(fetchImpl as any);
  const host = document.createElement("div");
  // No legacy overview panel: the banner decision must rest on loaded config.
  const hass = provideHass(host, { panels: {} });
  document.body.append(host);
  const panel = document.createElement("ha-panel-home") as unknown as HomePanel;
  host.append(panel);
  panel.hass = hass;
  await panel.updateComplete;
  await panel._loadConfigPromise;
  return panel;
};

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("home panel welcome banner", () => {
  it("stays hidden when the home config load is rejected", async () => {
    const { showNewOverviewDialog } =
      await import("../../../src/panels/home/dialogs/show-dialog-new-overview");
    let dismissed: Promise<void> | undefined;
    vi.mocked(showNewOverviewDialog).mockImplementation(((
      _el: any,
      opts: any
    ) => {
      dismissed = opts.dismiss();
    }) as any);
    const panel = await openPanel(async () => {
      throw new Error("no answer");
    });
    await panel.updateComplete;
    expect(panel._showBanner).toBe(false);
    // Defense in depth: even if invoked directly, dismiss must not persist
    // an unloaded (empty) config over stored favourites/shortcuts.
    (panel["_learnMore"] as () => void)();
    await dismissed;
    await panel.updateComplete;
    expect(mockedSaveFrontendSystemData).not.toHaveBeenCalled();
  });

  it("dismissing saves the loaded favourites, not an empty config", async () => {
    const { showNewOverviewDialog } =
      await import("../../../src/panels/home/dialogs/show-dialog-new-overview");
    let dismissed: Promise<void> | undefined;
    vi.mocked(showNewOverviewDialog).mockImplementation(((
      _el: any,
      opts: any
    ) => {
      dismissed = opts.dismiss();
    }) as any);
    const panel = await openPanel(async () => ({ ...STORED }));
    await panel.updateComplete;
    expect(panel._showBanner).toBe(true);
    (panel["_learnMore"] as () => void)();
    await dismissed;
    await panel.updateComplete;
    expect(mockedSaveFrontendSystemData).toHaveBeenCalledTimes(1);
    const saved = mockedSaveFrontendSystemData.mock.calls[0][2] as any;
    expect(saved.favorite_entities).toEqual(STORED.favorite_entities);
    expect(saved.shortcuts).toEqual(STORED.shortcuts);
    expect(saved.welcome_banner_dismissed).toBe(true);
  });
});

describe("home panel settings sidebar", () => {
  // Without the welcome banner, which is not under test here
  const loadConfig = async () => ({
    ...STORED,
    welcome_banner_dismissed: true,
  });

  it("reports unsaved changes while editing, and drops them when the panel is left", async () => {
    mockedGenerateLovelaceDashboardStrategy.mockResolvedValue({
      views: [],
    } as any);
    const panel = await openPanel(loadConfig);
    await panel.updateComplete;
    const el = panel as unknown as TestPanelHome;

    editHome(el);
    await panel.updateComplete;
    expect(window.isDirtyState).toBe(false);

    changeDraft(el, { show_welcome_message: false });
    await panel.updateComplete;
    const sidebar = panel.shadowRoot!.querySelector("home-settings-sidebar")!;
    await sidebar.updateComplete;
    expect(window.isDirtyState).toBe(true);

    // Navigating to another panel only disconnects this cached one.
    panel.remove();

    expect(session(el)).toBeUndefined();
    expect(window.isDirtyState).toBe(false);
  });

  it("keeps the panel while it slides out, but not once the page is left", async () => {
    mockedGenerateLovelaceDashboardStrategy.mockResolvedValue({
      views: [],
    } as any);
    const panel = await openPanel(loadConfig);
    await panel.updateComplete;
    const el = panel as unknown as TestPanelHome;
    const sidebar = () =>
      panel.shadowRoot!.querySelector("home-settings-sidebar");

    editHome(el);
    await panel.updateComplete;
    // A slide that is still running
    const getAnimations = vi
      .spyOn(Element.prototype, "getAnimations")
      .mockReturnValue([{ finished: deferred<undefined>().promise }] as any);
    cancelSettings(el);
    await panel.updateComplete;
    expect(sidebar()?.closing).toBe(true);
    getAnimations.mockRestore();

    // Left for another page, then back
    const host = panel.parentElement!;
    panel.remove();
    host.append(panel);
    await panel.updateComplete;
    expect(sidebar()).toBeNull();
  });

  it("gives a session reopened during the slide out a side panel of its own", async () => {
    mockedGenerateLovelaceDashboardStrategy.mockResolvedValue({
      views: [],
    } as any);
    const panel = await openPanel(loadConfig);
    await panel.updateComplete;
    const el = panel as unknown as TestPanelHome;
    const sidebar = () =>
      panel.shadowRoot!.querySelector("home-settings-sidebar")!;

    editHome(el);
    await panel.updateComplete;
    const first = sidebar();
    // Edits keep the same side panel.
    changeDraft(el, { show_welcome_message: false });
    await panel.updateComplete;
    expect(sidebar()).toBe(first);

    // A slide out that is still running
    const getAnimations = vi
      .spyOn(Element.prototype, "getAnimations")
      .mockReturnValue([{ finished: deferred<undefined>().promise }] as any);
    try {
      cancelSettings(el);
      await panel.updateComplete;
      expect(first.closing).toBe(true);

      editHome(el);
      await panel.updateComplete;
    } finally {
      getAnimations.mockRestore();
    }
    const second = sidebar();
    expect(second).not.toBe(first);
    expect(second.closing).toBe(false);
    await second.updateComplete;
    await vi.waitFor(() =>
      expect(second.shadowRoot!.activeElement).toBe(
        second.shadowRoot!.querySelector(".container")
      )
    );
  });

  it("disables the form while a save is in flight", async () => {
    mockedGenerateLovelaceDashboardStrategy.mockResolvedValue({
      views: [],
    } as any);
    const pending = deferred<undefined>();
    mockedSaveFrontendSystemData.mockReturnValueOnce(pending.promise as any);
    const panel = await openPanel(loadConfig);
    await panel.updateComplete;
    const el = panel as unknown as TestPanelHome;

    editHome(el);
    changeDraft(el, { show_welcome_message: false });
    const saving = saveSettings(el);
    await panel.updateComplete;

    const form = () =>
      panel.shadowRoot!.querySelector("home-settings-form") as
        (HTMLElement & { disabled: boolean }) | null;
    expect(form()!.disabled).toBe(true);

    pending.resolve(undefined);
    await saving;
    // Closing renders the sliding-out panel once, then removes it.
    await panel.updateComplete;
    await panel.updateComplete;
    expect(form()).toBeNull();
  });
});
