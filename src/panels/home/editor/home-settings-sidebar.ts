import type { ContextType } from "@lit/context";
import { mdiClose } from "@mdi/js";
import type { PropertyValues } from "lit";
import { css, html, LitElement } from "lit";
import { customElement, property, query, state } from "lit/decorators";
import { ifDefined } from "lit/directives/if-defined";
import { consume } from "../../../common/decorators/consume";
import { fireEvent } from "../../../common/dom/fire_event";
import "../../../components/ha-button";
import "../../../components/ha-icon-button";
import "../../../components/ha-snap-bottom-sheet";
import type { HaSnapBottomSheet } from "../../../components/ha-snap-bottom-sheet";
import { internationalizationContext } from "../../../data/context";
import { DirtyStateProviderMixin } from "../../../mixins/dirty-state-provider-mixin";

export type HomeSettingsPlacement = "start" | "end";

// Keeps the title in view when the bottom sheet is collapsed
const COLLAPSED_SHEET_HEIGHT = 68;

/**
 * Non-modal container for the home dashboard settings: a side panel next to
 * the dashboard it previews, or a bottom sheet when `narrow`. The form goes in
 * the default slot. Closing is left to the host, which owns the draft.
 *
 * @fires home-settings-cancel - Cancel, the close button, Escape on a clean
 * draft, or a swipe that dismisses the bottom sheet
 * @fires home-settings-save - Save
 * @fires home-settings-closed - Once the panel has slid out after `closing`
 * is set, or right away when `narrow`
 * @fires bottom-sheet-resized - Relayed from the bottom sheet when `narrow`
 */
@customElement("home-settings-sidebar")
export class HomeSettingsSidebar extends DirtyStateProviderMixin()(LitElement) {
  @property({ type: Boolean, reflect: true }) public narrow = false;

  @property({ type: Boolean }) public dirty = false;

  @property({ type: Boolean }) public submitting = false;

  /** Slides the panel out; the host removes it on `home-settings-closed` */
  @property({ type: Boolean, reflect: true }) public closing = false;

  /** The side of the dashboard the panel sits on, unless `narrow` */
  @property({ reflect: true }) public placement: HomeSettingsPlacement = "end";

  @state()
  @consume({ context: internationalizationContext, subscribe: true })
  private _i18n!: ContextType<typeof internationalizationContext>;

  @query(".container") private _container?: HTMLElement;

  @query("ha-snap-bottom-sheet") private _sheet?: HaSnapBottomSheet;

  // The draft lives in the host, so this only reports it to block automatic
  // frontend reloads while it has unsaved changes.
  protected get _blocksReload(): boolean {
    return this.dirty;
  }

  protected render() {
    const content = this._renderContent();
    if (this.narrow) {
      return html`
        <ha-snap-bottom-sheet
          .dismissable=${!this.dirty && !this.submitting}
          .minHeight=${COLLAPSED_SHEET_HEIGHT}
          .label=${this._i18n.localize("ui.panel.home.editor.title")}
          @bottom-sheet-closed=${this._cancel}
        >
          ${content}
        </ha-snap-bottom-sheet>
      `;
    }
    return content;
  }

  private _renderContent() {
    // When narrow, the bottom sheet is already the region named after the
    // title: naming this one as well would announce it twice.
    return html`
      <section
        class="container"
        tabindex="-1"
        aria-labelledby=${ifDefined(this.narrow ? undefined : "title")}
        @keydown=${this._keyDown}
      >
        <div class="header">
          <div class="titles">
            <h2 id="title">
              ${this._i18n.localize("ui.panel.home.editor.title")}
            </h2>
            <p class="subtitle">
              ${this._i18n.localize("ui.panel.home.editor.description")}
            </p>
          </div>
          <ha-icon-button
            .label=${this._i18n.localize("ui.common.close")}
            .path=${mdiClose}
            .disabled=${this.submitting}
            @click=${this._cancel}
          ></ha-icon-button>
        </div>
        <div class="content">
          <slot></slot>
        </div>
        <div class="footer">
          <ha-button
            appearance="plain"
            .disabled=${this.submitting}
            @click=${this._cancel}
          >
            ${this._i18n.localize("ui.common.cancel")}
          </ha-button>
          <ha-button
            .disabled=${!this.dirty}
            .loading=${this.submitting}
            @click=${this._save}
          >
            ${this._i18n.localize("ui.common.save")}
          </ha-button>
        </div>
      </section>
    `;
  }

  private _layoutTransitionActive = false;

  protected firstUpdated(changedProps: PropertyValues<this>): void {
    super.firstUpdated(changedProps);
    this._focusContainer();
    this._slideDone();
  }

  // Each slide in or out takes over from the one before it.
  private _slideCount = 0;

  private async _focusContainer(): Promise<void> {
    // The bottom sheet's content cannot take the focus until its first
    // render has shown it.
    await this._sheet?.updateComplete;
    this._container?.focus({ preventScroll: true });
  }

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    this._setLayoutTransition(false);
  }

  /**
   * The dashboard resizes along with the slide: like the app sidebar, tell
   * charts to hold their resizing until it ends.
   */
  private _setLayoutTransition(active: boolean): void {
    if (this._layoutTransitionActive === active) {
      return;
    }
    this._layoutTransitionActive = active;
    fireEvent(window, "hass-layout-transition", {
      active,
      reason: "home-settings",
    });
  }

  private async _slideDone(): Promise<void> {
    const slide = ++this._slideCount;
    const closing = this.closing;
    const animations = this.narrow ? [] : this.getAnimations();
    if (animations.length) {
      this._setLayoutTransition(true);
      await Promise.allSettled(animations.map((a) => a.finished));
      // Closed during the slide in: the slide out, which cancelled it, now
      // holds the layout transition and reports the end.
      if (slide !== this._slideCount) {
        return;
      }
      this._setLayoutTransition(false);
    }
    // Removed meanwhile: there is nothing left to close.
    if (closing && this.isConnected) {
      fireEvent(this, "home-settings-closed");
    }
  }

  protected updated(changedProps: PropertyValues<this>): void {
    super.updated(changedProps);
    if (changedProps.has("closing") && this.closing) {
      this._slideDone();
    }
    // Switching between the panel and the bottom sheet re-creates the
    // container, which would otherwise drop the focus.
    if (
      changedProps.has("narrow") &&
      changedProps.get("narrow") !== undefined
    ) {
      this._focusContainer();
    }
  }

  private _keyDown(ev: KeyboardEvent): void {
    // Escape must not throw away unsaved changes, unlike the buttons.
    if (
      ev.key !== "Escape" ||
      ev.defaultPrevented ||
      this.dirty ||
      this.submitting
    ) {
      return;
    }
    ev.stopPropagation();
    this._cancel();
  }

  private _cancel(): void {
    if (this.submitting) {
      return;
    }
    fireEvent(this, "home-settings-cancel");
  }

  private _save(): void {
    if (this.submitting || !this.dirty) {
      return;
    }
    fireEvent(this, "home-settings-save");
  }

  static styles = css`
    :host {
      --home-settings-slide-from: 100%;
    }
    :host(:not([narrow])) {
      box-sizing: border-box;
      position: fixed;
      top: calc(var(--header-height, 56px) + var(--safe-area-inset-top, 0px));
      bottom: 0;
      inset-inline-end: 0;
      width: var(--home-settings-width);
      z-index: 5;
      display: flex;
      background-color: var(--card-background-color);
      border-inline-start: 1px solid var(--divider-color);
      box-shadow: var(--ha-box-shadow-l);
      animation: slide-in var(--ha-animation-duration-normal) ease;
    }
    :host(:not([narrow])[closing]) {
      animation: slide-out var(--ha-animation-duration-normal) ease forwards;
    }
    :host(:not([narrow])[placement="start"]) {
      inset-inline-start: var(--ha-sidebar-width, 0px);
      inset-inline-end: auto;
      border-inline-start: none;
      border-inline-end: 1px solid var(--divider-color);
      --home-settings-slide-from: -100%;
    }
    :host(:dir(rtl)) {
      --home-settings-slide-from: -100%;
    }
    :host([placement="start"]:dir(rtl)) {
      --home-settings-slide-from: 100%;
    }
    @keyframes slide-in {
      from {
        transform: translateX(var(--home-settings-slide-from));
      }
    }
    @keyframes slide-out {
      to {
        transform: translateX(var(--home-settings-slide-from));
      }
    }

    .container {
      flex: 1;
      min-width: 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
      outline: none;
    }
    :host([narrow]) .container {
      /* Room for the bottom sheet handle */
      padding-top: var(--ha-space-4);
    }

    .header {
      display: flex;
      align-items: flex-start;
      gap: var(--ha-space-2);
      padding-block: var(--ha-space-4) var(--ha-space-2);
      padding-inline: var(--ha-space-6) var(--ha-space-2);
    }
    .titles {
      flex: 1;
      min-width: 0;
    }
    h2 {
      margin: 0;
      font-size: var(--ha-font-size-xl);
      font-weight: var(--ha-font-weight-normal);
      line-height: var(--ha-line-height-condensed);
      color: var(--primary-text-color);
    }
    .subtitle {
      margin: var(--ha-space-1) 0 0;
      font-size: var(--ha-font-size-m);
      color: var(--secondary-text-color);
    }

    .content {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: var(--ha-space-2) var(--ha-space-6) var(--ha-space-4);
    }

    .footer {
      display: flex;
      justify-content: flex-end;
      gap: var(--ha-space-2);
      padding: var(--ha-space-3) var(--ha-space-6);
      padding-bottom: calc(
        var(--ha-space-3) + var(--safe-area-inset-bottom, 0px)
      );
      border-top: 1px solid var(--divider-color);
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "home-settings-sidebar": HomeSettingsSidebar;
  }

  interface HASSDomEvents {
    "home-settings-cancel": undefined;
    "home-settings-save": undefined;
    "home-settings-closed": undefined;
  }
}
