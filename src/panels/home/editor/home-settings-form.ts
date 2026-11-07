import { css, html, LitElement } from "lit";
import { customElement, property } from "lit/decorators";
import memoizeOne from "memoize-one";
import { fireEvent } from "../../../common/dom/fire_event";
import "../../../components/entity/ha-favorites-editor";
import "../../../components/ha-alert";
import "../../../components/ha-expansion-panel";
import "../../../components/ha-form/ha-form";
import type { HaFormSchema } from "../../../components/ha-form/types";
import "../../../components/ha-icon";
import type { ShortcutItem } from "../../../data/home_shortcuts";
import type { HomeAssistant, ValueChangedEvent } from "../../../types";
import "../components/home-shortcuts-editor";
import type { EditorState } from "./home-config-editor-state";

// The common-controls strategy caps the section at 8 (or the favorites count,
// whichever is larger); once favorites reach the cap, predictions never render
// so the suggested-entities toggle has no effect.
const SUGGESTED_ENTITIES_CAP = 8;

const WELCOME_SCHEMA: HaFormSchema[] = [
  { name: "show_welcome_message", selector: { boolean: {} } },
];

/**
 * The home dashboard settings, without any container: it edits `draft` and
 * knows nothing about saving or how it is presented.
 *
 * @fires value-changed - With the new `EditorState` after each edit
 */
@customElement("home-settings-form")
export class HomeSettingsForm extends LitElement {
  // ha-form and home-shortcuts-editor still take the full hass object.
  @property({ attribute: false }) public hass!: HomeAssistant;

  @property({ attribute: false }) public draft!: EditorState;

  @property({ type: Boolean }) public disabled = false;

  protected render() {
    const draft = this.draft;
    const favoritesFull =
      draft.favorite_entities.length >= SUGGESTED_ENTITIES_CAP;

    return html`
      <ha-alert alert-type="info">
        ${this.hass.localize("ui.panel.home.editor.areas_hint", {
          areas_page: html`<a
            href="/config/areas?historyBack=1"
            @click=${this._areasLinkClicked}
            >${this.hass.localize("ui.panel.home.editor.areas_page")}</a
          >`,
        })}
      </ha-alert>

      <ha-expansion-panel
        outlined
        expanded
        .header=${this.hass.localize("ui.panel.home.editor.personalize")}
        .secondary=${this.hass.localize(
          "ui.panel.home.editor.personalize_description"
        )}
      >
        <ha-icon slot="leading-icon" icon="mdi:palette-outline"></ha-icon>
        <div class="expansion-content">
          <ha-form
            .hass=${this.hass}
            .data=${this._welcomeData(draft.show_welcome_message)}
            .schema=${WELCOME_SCHEMA}
            .disabled=${this.disabled}
            .computeLabel=${this._computeWelcomeLabel}
            .computeHelper=${this._computeWelcomeHelper}
            @value-changed=${this._welcomeChanged}
          ></ha-form>

          <ha-favorites-editor
            .favorites=${draft.favorite_entities}
            .label=${this.hass.localize(
              "ui.panel.lovelace.editor.strategy.home.favorite_entities"
            )}
            .addButtonLabel=${this.hass.localize(
              "ui.panel.lovelace.editor.strategy.home.add_favorite_entity"
            )}
            .disabled=${this.disabled}
            @value-changed=${this._favoriteEntitiesChanged}
          ></ha-favorites-editor>

          <ha-form
            .hass=${this.hass}
            .data=${this._suggestedData(draft.show_suggested_entities)}
            .schema=${this._suggestedSchema(favoritesFull)}
            .disabled=${this.disabled}
            .computeLabel=${this._computeSuggestedLabel}
            .computeHelper=${
              favoritesFull
                ? this._computeSuggestedFullHelper
                : this._computeSuggestedHelper
            }
            @value-changed=${this._suggestedChanged}
          ></ha-form>
        </div>
      </ha-expansion-panel>

      <ha-expansion-panel
        outlined
        expanded
        .header=${this.hass.localize("ui.panel.home.editor.summaries")}
        .secondary=${this.hass.localize(
          "ui.panel.home.editor.summaries_description"
        )}
      >
        <ha-icon
          slot="leading-icon"
          icon="mdi:view-dashboard-outline"
        ></ha-icon>
        <div class="expansion-content">
          <home-shortcuts-editor
            .hass=${this.hass}
            .shortcuts=${draft.shortcuts}
            .disabled=${this.disabled}
            @value-changed=${this._shortcutsChanged}
          ></home-shortcuts-editor>
        </div>
      </ha-expansion-panel>
    `;
  }

  private _areasLinkClicked(ev: MouseEvent): void {
    // Leaving the page drops the draft, but never in the middle of a save.
    if (this.disabled) {
      ev.preventDefault();
    }
  }

  private _welcomeData = memoizeOne((show_welcome_message: boolean) => ({
    show_welcome_message,
  }));

  private _suggestedData = memoizeOne((show_suggested_entities: boolean) => ({
    show_suggested_entities,
  }));

  private _suggestedSchema = memoizeOne(
    (disabled: boolean) =>
      [
        {
          name: "show_suggested_entities",
          selector: { boolean: {} },
          disabled,
        },
      ] as HaFormSchema[]
  );

  private _computeWelcomeLabel = (): string =>
    this.hass.localize("ui.panel.home.editor.welcome_message");

  private _computeWelcomeHelper = (): string =>
    this.hass.localize("ui.panel.home.editor.welcome_message_helper");

  private _computeSuggestedLabel = (): string =>
    this.hass.localize("ui.panel.home.editor.suggested_entities");

  private _computeSuggestedHelper = (): string =>
    this.hass.localize("ui.panel.home.editor.suggested_entities_description");

  private _computeSuggestedFullHelper = (): string =>
    this.hass.localize(
      "ui.panel.home.editor.suggested_entities_disabled_description"
    );

  private _changed(patch: Partial<EditorState>): void {
    fireEvent(this, "value-changed", { value: { ...this.draft, ...patch } });
  }

  private _welcomeChanged(
    ev: ValueChangedEvent<{ show_welcome_message: boolean }>
  ): void {
    ev.stopPropagation();
    this._changed({
      show_welcome_message: ev.detail.value.show_welcome_message,
    });
  }

  private _favoriteEntitiesChanged(ev: ValueChangedEvent<string[]>): void {
    ev.stopPropagation();
    this._changed({ favorite_entities: ev.detail.value });
  }

  private _suggestedChanged(
    ev: ValueChangedEvent<{ show_suggested_entities: boolean }>
  ): void {
    ev.stopPropagation();
    this._changed({
      show_suggested_entities: ev.detail.value.show_suggested_entities,
    });
  }

  private _shortcutsChanged(ev: ValueChangedEvent<ShortcutItem[]>): void {
    ev.stopPropagation();
    this._changed({ shortcuts: ev.detail.value });
  }

  static styles = css`
    :host {
      display: block;
    }

    ha-alert {
      display: block;
      margin-bottom: var(--ha-space-4);
    }

    ha-expansion-panel {
      display: block;
      --expansion-panel-content-padding: 0;
      border-radius: var(--ha-border-radius-md);
      --ha-card-border-radius: var(--ha-border-radius-md);
    }

    ha-expansion-panel + ha-expansion-panel {
      margin-top: var(--ha-space-2);
    }

    .expansion-content {
      padding: var(--ha-space-3);
    }

    ha-form {
      display: block;
    }

    ha-favorites-editor {
      display: block;
      margin-top: var(--ha-space-2);
      margin-bottom: var(--ha-space-4);
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "home-settings-form": HomeSettingsForm;
  }
}
