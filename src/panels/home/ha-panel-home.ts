import { ResizeController } from "@lit-labs/observers/resize-controller";
import { mdiPencil } from "@mdi/js";
import type { CSSResultGroup, PropertyValues } from "lit";
import { LitElement, css, html, nothing } from "lit";
import { customElement, property, query, state } from "lit/decorators";
import { classMap } from "lit/directives/class-map";
import { styleMap } from "lit/directives/style-map";
import { atLeastVersion } from "../../common/config/version";
import { deepActiveElement } from "../../common/dom/deep-active-element";
import type { HASSDomEvent } from "../../common/dom/fire_event";
import { navigate } from "../../common/navigate";
import { debounce } from "../../common/util/debounce";
import { deepEqual } from "../../common/util/deep-equal";
import "../../components/ha-button";
import "../../components/ha-svg-icon";
import { updateAreaRegistryEntry } from "../../data/area/area_registry";
import { updateDeviceRegistryEntry } from "../../data/device/device_registry";
import {
  fetchFrontendSystemData,
  saveFrontendSystemData,
  subscribeFrontendSystemData,
  type HomeFrontendSystemData,
  type SecurityFrontendSystemData,
} from "../../data/frontend";
import type { LovelaceDashboardStrategyConfig } from "../../data/lovelace/config/types";
import { SubscribeMixin } from "../../mixins/subscribe-mixin";
import { mdiHomeAssistant } from "../../resources/home-assistant-logo-svg";
import type {
  HomeAssistant,
  PanelInfo,
  Route,
  ValueChangedEvent,
} from "../../types";
import { showToast } from "../../util/toast";
import { showAreaRegistryDetailDialog } from "../config/areas/show-dialog-area-registry-detail";
import { showDeviceRegistryDetailDialog } from "../config/devices/device-registry-detail/show-dialog-device-registry-detail";
import { showAddIntegrationDialog } from "../config/integrations/show-add-integration-dialog";
import "../lovelace/hui-root";
import type { ExtraActionItem } from "../lovelace/hui-root";
import {
  checkStrategyShouldRegenerate,
  generateLovelaceDashboardStrategy,
} from "../lovelace/strategies/get-strategy";
import type { Lovelace } from "../lovelace/types";
import { showNewOverviewDialog } from "./dialogs/show-dialog-new-overview";
import { hasLegacyOverviewPanel } from "../../data/panel";
import {
  editorStatesEqual,
  HomeConfigDraftSession,
} from "./editor/home-config-draft-session";
import {
  buildHomeConfig,
  editorStateFromConfig,
  type EditorState,
} from "./editor/home-config-editor-state";
import "./editor/home-settings-form";
import "./editor/home-settings-sidebar";
import type { HomeSettingsPlacement } from "./editor/home-settings-sidebar";

// The side of the dashboard the settings panel sits on, on wide screens.
const SETTINGS_PANEL_PLACEMENT: HomeSettingsPlacement = "end";

@customElement("ha-panel-home")
class PanelHome extends SubscribeMixin(LitElement) {
  @property({ attribute: false }) public hass!: HomeAssistant;

  @property({ type: Boolean, reflect: true }) public narrow = false;

  @property({ attribute: false }) public route?: Route;

  @property({ attribute: false }) public panel?: PanelInfo;

  @state() private _lovelace?: Lovelace;

  @state() private _config?: HomeFrontendSystemData;

  // The settings being edited, if any. The dashboard previews its draft.
  @state() private _session?: HomeConfigDraftSession;

  @state() private _submitting = false;

  @state() private _settingsSheetHeight?: number;

  @state() private _securityConfig: SecurityFrontendSystemData = {};

  @state() private _extraActionItems?: ExtraActionItem[];

  @query(".banner") private _banner?: HTMLElement;

  private _loadConfigPromise?: Promise<void>;

  private _lovelaceGeneration = 0;

  private _securityConfigRevision = 0;

  // Where the focus was when the settings opened, to bring it back on close
  private _settingsOpener?: Element | null;

  public hassSubscribe() {
    return [
      subscribeFrontendSystemData(
        this.hass.connection,
        "security",
        ({ value }) => {
          this._securityConfigRevision++;
          const config = value || {};
          if (deepEqual(config, this._securityConfig)) {
            return;
          }
          this._securityConfig = config;
          if (this.hasUpdated) {
            this._setLovelace();
          }
        }
      ),
    ];
  }

  private get _showBanner(): boolean {
    // Don't show until the config loaded or if already dismissed
    if (!this._config || this._config.welcome_banner_dismissed) {
      return false;
    }
    // Don't show if HA is not running
    if (this.hass.config.state !== "RUNNING") {
      return false;
    }
    // Show banner only for users who:
    // 1. Were onboarded before 2026.2 (or have no onboarded_version)
    // 2. Don't have a custom "lovelace" dashboard (old overview)
    const onboardedVersion = this.hass.systemData?.onboarded_version;
    const isNewInstance =
      onboardedVersion && atLeastVersion(onboardedVersion, 2026, 2);
    const hasOldOverview = hasLegacyOverviewPanel(this.hass);
    return !isNewInstance && !hasOldOverview;
  }

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    // This panel is cached, so leaving it for another one only disconnects
    // it: drop the draft then, like Cancel. A tab hidden for a while is
    // disconnected too, and keeps the draft for when it comes back.
    if (!document.hidden) {
      this._closeSettings();
    }
  }

  private _bannerHeight = new ResizeController(this, {
    target: null,
    callback: (entries) =>
      (entries[0]?.target as HTMLElement | undefined)?.offsetHeight ?? 0,
  });

  public willUpdate(changedProps: PropertyValues<this>) {
    super.willUpdate(changedProps);
    // Initial setup
    if (!this.hasUpdated) {
      this._setup();
      return;
    }

    if (changedProps.has("route")) {
      this._updateExtraActionItems();
      const oldRoute = changedProps.get("route") as Route | undefined;
      if (oldRoute && oldRoute.path !== this.route?.path) {
        // Leaving the page drops the draft, like Cancel.
        this._closeSettings();
      }
    }

    if (!changedProps.has("hass")) {
      return;
    }

    const oldHass = changedProps.get("hass") as this["hass"] | undefined;
    if (!oldHass) {
      return;
    }

    // Locale changed: regenerate to refresh translated content
    if (oldHass.localize !== this.hass.localize) {
      // A pending preview debounce would otherwise still fire later and
      // trigger a redundant second regeneration on top of this one.
      this._debounceRegenerateStrategy.cancel();
      this._setLovelace();
      return;
    }

    if (this.hass.config.state !== "RUNNING") {
      return;
    }

    // Home Assistant just started: run the full setup
    if (oldHass.config.state !== "RUNNING") {
      this._setup();
      return;
    }

    // A registry the strategy depends on changed: regenerate
    if (
      checkStrategyShouldRegenerate(
        "dashboard",
        this._strategyConfig.strategy,
        oldHass,
        this.hass
      )
    ) {
      this._debounceRegenerateStrategy();
    }
  }

  private async _setup() {
    void import("../lovelace/strategies/home/home-dashboard-strategy").catch(
      () => undefined
    );
    void import("../lovelace/strategies/home/home-overview-view-strategy")
      .then(({ preloadHomeEnergyPreferences }) => {
        const path = this.route?.path?.split("/")[1];
        return !path || path === "overview"
          ? preloadHomeEnergyPreferences(this.hass)
          : undefined;
      })
      .catch(() => undefined);
    void import("../lovelace/views/hui-sections-view").catch(() => undefined);

    this._updateExtraActionItems();
    this._loadConfigPromise = this._loadConfig();
    await this._loadConfigPromise;
    this._setLovelace();
  }

  private async _loadConfig() {
    const securityConfigRevision = this._securityConfigRevision;
    const [translationsResult, homeResult, securityResult] =
      await Promise.allSettled([
        this.hass.loadFragmentTranslation("lovelace"),
        fetchFrontendSystemData(this.hass.connection, "home"),
        fetchFrontendSystemData(this.hass.connection, "security"),
      ]);

    if (translationsResult.status === "rejected") {
      // eslint-disable-next-line no-console
      console.error(
        "Failed to load Lovelace translations:",
        translationsResult.reason
      );
    }

    if (homeResult.status === "rejected") {
      // eslint-disable-next-line no-console
      console.error("Failed to load home configuration:", homeResult.reason);
      this._config = undefined;
    } else {
      this._config = homeResult.value || {};
    }

    if (securityResult.status === "rejected") {
      // eslint-disable-next-line no-console
      console.error(
        "Failed to load security configuration:",
        securityResult.reason
      );
      if (securityConfigRevision === this._securityConfigRevision) {
        this._securityConfig = {};
      }
    } else if (securityConfigRevision === this._securityConfigRevision) {
      this._securityConfig = securityResult.value || {};
    }
  }

  private _debounceRegenerateStrategy = debounce(
    () => this._regenerateStrategyConfig(),
    200
  );

  private _regenerateStrategyConfig() {
    // If on an area view that no longer exists, redirect to overview
    const path = this.route?.path?.split("/")[1];
    if (path?.startsWith("areas-")) {
      const areaId = path.replace("areas-", "");
      if (!this.hass.areas[areaId]) {
        navigate("/home");
        return;
      }
    }
    this._setLovelace();
  }

  private _updateExtraActionItems() {
    const path = this.route?.path?.split("/")[1];

    if (path?.startsWith("areas-")) {
      this._extraActionItems = [
        {
          icon: mdiPencil,
          labelKey: "ui.panel.lovelace.menu.edit_area",
          action: this._editArea,
        },
      ];
    } else if (!path || path === "overview") {
      this._extraActionItems = [
        {
          icon: mdiPencil,
          labelKey: "ui.panel.lovelace.menu.edit_overview",
          action: this._editHome,
        },
      ];
    } else {
      this._extraActionItems = undefined;
    }
  }

  private _editHome = () => {
    // A save that outlived its session (e.g. after a route change) is still
    // running: wait for it, so two saves never overlap.
    if (this._session || this._submitting) {
      return;
    }
    this._settingsOpener = deepActiveElement();
    this._session = HomeConfigDraftSession.start(
      editorStateFromConfig(this._config ?? {})
    );
  };

  private _settingsChanged(ev: ValueChangedEvent<EditorState>): void {
    ev.stopPropagation();
    const session = this._session;
    if (
      !session ||
      this._submitting ||
      editorStatesEqual(ev.detail.value, session.draft)
    ) {
      return;
    }
    this._session = session.withDraft(ev.detail.value);
    // Invalidate any in-flight _setLovelace() call synchronously: without
    // this, a stale generation started before this edit could still resolve
    // and be applied before the debounced regeneration below even starts.
    this._lovelaceGeneration++;
    this._debounceRegenerateStrategy();
  }

  private _cancelSettings(): void {
    if (this._submitting) {
      return;
    }
    this._closeSettings();
  }

  private async _saveSettings(): Promise<void> {
    const session = this._session;
    if (!session || this._submitting || !session.isDirty) {
      return;
    }
    // The form is disabled while saving, so the draft cannot change under
    // this save: it either closes the session or leaves it as it was.
    this._submitting = true;
    try {
      const success = await this._saveConfig(
        buildHomeConfig(this._config ?? {}, session.draft)
      );
      if (success) {
        // _saveConfig() already regenerated from the saved config. If a
        // route change closed the session meanwhile, this does nothing: no
        // other session can open before the save is done (_editHome()).
        this._closeSettings(false);
      }
    } finally {
      this._submitting = false;
    }
  }

  /**
   * Drops the draft. Unless the save already did, the dashboard goes back to
   * the saved config if the session ever previewed a change.
   */
  private _closeSettings(revertPreview = true): void {
    const session = this._session;
    if (!session) {
      return;
    }
    this._session = undefined;
    this._settingsSheetHeight = undefined;
    if (revertPreview && session.generation > 0) {
      this._debounceRegenerateStrategy.cancel();
      this._setLovelace();
    }
    this._restoreFocus();
  }

  private async _restoreFocus(): Promise<void> {
    const opener = this._settingsOpener;
    this._settingsOpener = undefined;
    // hui-root stays inert until the next render.
    await this.updateComplete;
    if (!this.isConnected) {
      return;
    }
    if (
      opener instanceof HTMLElement &&
      opener !== document.body &&
      opener.isConnected
    ) {
      opener.focus();
      // A menu item the settings were opened from is hidden by now.
      if (deepActiveElement() === opener) {
        return;
      }
    }
    // Not focusable otherwise; -1 keeps it out of the tab order.
    this.tabIndex = -1;
    this.focus();
  }

  private _settingsSheetResized(ev: HASSDomEvent<{ height: number }>): void {
    this._settingsSheetHeight = ev.detail.height;
  }

  private _editArea = async () => {
    const path = this.route?.path?.split("/")[1];
    if (!path?.startsWith("areas-")) {
      return;
    }
    const areaId = path.replace("areas-", "");
    const area = this.hass.areas[areaId];
    if (!area) {
      return;
    }
    await this.hass.loadFragmentTranslation("config");
    showAreaRegistryDetailDialog(this, {
      entry: area,
      updateEntry: (values) =>
        updateAreaRegistryEntry(this.hass.callWS, areaId, values),
    });
  };

  private _handleLLCustomEvent = (ev: Event) => {
    const detail = (ev as CustomEvent).detail;
    if (detail.home_panel) {
      const { type } = detail.home_panel;
      switch (type) {
        case "assign_area": {
          const { device_id } = detail.home_panel;
          this._showAssignAreaDialog(device_id);
          break;
        }
        case "add_integration": {
          this._showAddIntegrationDialog();
          break;
        }
      }
    }
  };

  private async _showAddIntegrationDialog() {
    await this.hass.loadFragmentTranslation("config");
    showAddIntegrationDialog(this, { navigateToResult: false });
  }

  private _showAssignAreaDialog(deviceId: string) {
    const device = this.hass.devices[deviceId];
    if (!device) {
      return;
    }
    showDeviceRegistryDetailDialog(this, {
      device,
      updateEntry: async (updates) => {
        await updateDeviceRegistryEntry(this.hass, deviceId, updates);
      },
    });
  }

  protected render() {
    if (!this._lovelace) {
      return nothing;
    }

    const session = this._session;
    const sidePanel = session && !this.narrow;
    const settingsClasses = {
      "settings-start":
        Boolean(sidePanel) && SETTINGS_PANEL_PLACEMENT === "start",
      "settings-end": Boolean(sidePanel) && SETTINGS_PANEL_PLACEMENT === "end",
    };
    const sheetHeight =
      session && this.narrow ? this._settingsSheetHeight : undefined;

    const huiRootStyle = styleMap({
      "--view-container-padding-top": this._bannerHeight.value
        ? `${this._bannerHeight.value}px`
        : undefined,
      // Lets the whole preview scroll above the bottom sheet
      "--view-container-padding-bottom":
        sheetHeight !== undefined ? `${sheetHeight}px` : undefined,
    });

    // While editing, the dashboard is a preview only: inert, but scrollable.
    return html`
      ${this._renderBanner(settingsClasses)}
      <hui-root
        class=${classMap(settingsClasses)}
        ?inert=${Boolean(session)}
        .hass=${this.hass}
        .narrow=${this.narrow}
        .lovelace=${this._lovelace}
        .route=${this.route}
        .panel=${this.panel}
        no-edit
        .extraActionItems=${this._extraActionItems}
        @ll-custom=${this._handleLLCustomEvent}
        style=${huiRootStyle}
      ></hui-root>
      ${
        session
          ? html`
              <home-settings-sidebar
                .narrow=${this.narrow}
                .placement=${SETTINGS_PANEL_PLACEMENT}
                .dirty=${session.isDirty}
                .submitting=${this._submitting}
                @home-settings-cancel=${this._cancelSettings}
                @home-settings-save=${this._saveSettings}
                @bottom-sheet-resized=${this._settingsSheetResized}
              >
                <home-settings-form
                  .hass=${this.hass}
                  .draft=${session.draft}
                  .disabled=${this._submitting}
                  @value-changed=${this._settingsChanged}
                ></home-settings-form>
              </home-settings-sidebar>
            `
          : nothing
      }
    `;
  }

  private _renderBanner(settingsClasses: Record<string, boolean>) {
    if (!this._showBanner) {
      return nothing;
    }

    return html`
      <div
        class="banner ${classMap(settingsClasses)}"
        ?inert=${Boolean(this._session)}
      >
        <div class="banner-content">
          <ha-svg-icon .path=${mdiHomeAssistant}></ha-svg-icon>
          <span class="banner-text">
            ${this.hass.localize("ui.panel.home.banner.welcome_message")}
          </span>
        </div>
        <div class="banner-actions">
          <ha-button size="s" appearance="filled" @click=${this._learnMore}>
            ${this.hass.localize("ui.panel.home.banner.learn_more")}
          </ha-button>
        </div>
      </div>
    `;
  }

  protected updated(changedProps: PropertyValues) {
    super.updated(changedProps);
    if (changedProps.has("_showBanner") || changedProps.has("_lovelace")) {
      if (this._banner) {
        this._bannerHeight.observe(this._banner);
      }
    }
  }

  private _learnMore() {
    showNewOverviewDialog(this, {
      dismiss: async () => {
        if (!this._config) {
          return;
        }
        const newConfig = {
          ...this._config,
          welcome_banner_dismissed: true,
        };
        this._config = newConfig;
        await saveFrontendSystemData(this.hass.connection, "home", newConfig);
      },
    });
  }

  private get _strategyConfig(): LovelaceDashboardStrategyConfig {
    // While editing, the dashboard previews the draft.
    const config = this._session
      ? buildHomeConfig(this._config ?? {}, this._session.draft)
      : this._config;
    return {
      strategy: {
        type: "home",
        alert_entities: this._securityConfig.alert_entities,
        favorite_entities: config?.favorite_entities,
        home_panel: true,
        hide_welcome_message: config?.hide_welcome_message,
        hide_suggested_entities: config?.hide_suggested_entities,
        shortcuts: config?.shortcuts,
      },
    };
  }

  private async _setLovelace() {
    const generation = ++this._lovelaceGeneration;
    if (this._loadConfigPromise) {
      await this._loadConfigPromise;
    }
    const config = await generateLovelaceDashboardStrategy(
      this._strategyConfig,
      this.hass
    );

    if (generation !== this._lovelaceGeneration) {
      // A newer call to _setLovelace() started (and may have already
      // finished) while this one was still generating. Discard this
      // stale result instead of overwriting a more recent one.
      return;
    }

    this._lovelace = {
      config: config,
      rawConfig: config,
      editMode: false,
      urlPath: "home",
      mode: "generated",
      locale: this.hass.locale,
      enableFullEditMode: () => undefined,
      saveConfig: async () => undefined,
      deleteConfig: async () => undefined,
      setEditMode: () => undefined,
      showToast: () => undefined,
    };
  }

  private async _saveConfig(config: HomeFrontendSystemData): Promise<boolean> {
    try {
      await saveFrontendSystemData(this.hass.connection, "home", config);
      this._config = config || {};
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error("Failed to save home configuration:", err);
      showToast(this, {
        message: this.hass.localize("ui.panel.home.editor.save_failed"),
        duration: 0,
        dismissable: true,
      });
      return false;
    }
    showToast(this, {
      message: this.hass.localize("ui.common.successfully_saved"),
    });
    // An edit made just before Save may still have a debounced
    // regeneration pending; the immediate refresh below already covers it.
    this._debounceRegenerateStrategy.cancel();
    this._setLovelace();
    return true;
  }

  static readonly styles: CSSResultGroup = css`
    :host {
      display: block;
      /* As wide as the former dialog, leaving the dashboard at least about
         one column of cards */
      --home-settings-width: min(
        580px,
        max(320px, 100vw - var(--ha-sidebar-width, 0px) - 360px)
      );
    }
    :host(:focus) {
      outline: none;
    }
    hui-root.settings-end {
      --view-container-margin-inline-end: var(--home-settings-width);
    }
    hui-root.settings-start {
      --view-container-margin-inline-start: var(--home-settings-width);
    }
    .banner.settings-end {
      margin-inline-end: var(--home-settings-width);
    }
    .banner.settings-start {
      margin-inline-start: var(--home-settings-width);
    }
    .banner {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      padding: var(--ha-space-2) var(--ha-space-4);
      background-color: var(--primary-color);
      color: var(--text-primary-color);
      gap: var(--ha-space-2);
      position: fixed;
      top: var(--header-height, 56px);
      left: var(--ha-sidebar-width, 0px);
      right: 0;
      z-index: 5;
    }
    .banner-content {
      display: flex;
      align-items: center;
      gap: var(--ha-space-2);
      flex: 1;
      min-width: 200px;
    }
    .banner ha-svg-icon {
      --mdc-icon-size: 24px;
      flex-shrink: 0;
    }
    .banner-text {
      font-size: 14px;
      font-weight: 500;
    }
    .banner-actions {
      display: flex;
      flex: none;
      gap: var(--ha-space-2);
      align-items: center;
      margin-inline-start: auto;
    }
    .banner-actions ha-button::part(base) {
      text-wrap: nowrap;
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "ha-panel-home": PanelHome;
  }
}
