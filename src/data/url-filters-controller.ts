import type { ReactiveController, ReactiveControllerHost } from "lit";

/**
 * Reactive controller that prevents URL-injected filters from persisting
 * in sessionStorage after the host component is disconnected.
 *
 * When a dashboard is navigated to with URL parameters that inject filters
 * (e.g. ?domain=hacs, ?blueprint=xxx), those filters are cleared on
 * disconnect, restoring any filters the user had previously set manually.
 *
 * Usage:
 *   private _urlFilters = new UrlFiltersController(
 *     this,
 *     () => this._filters,
 *     (f) => { this._filters = f; }
 *   );
 *
 *   // In the method that applies URL-injected filters, before overwriting:
 *   this._urlFilters.saveBeforeUrlFilters();
 */
export class UrlFiltersController<
  F extends object,
> implements ReactiveController {
  private _fromUrl = false;

  private _previous?: F;

  constructor(
    host: ReactiveControllerHost,
    private readonly _getFilters: () => F,
    private readonly _setFilters: (filters: F) => void
  ) {
    host.addController(this);
  }

  hostDisconnected(): void {
    if (this._fromUrl) {
      this._setFilters(this._previous ?? ({} as F));
      this._fromUrl = false;
      this._previous = undefined;
    }
  }

  /**
   * Call once before applying URL-injected filters.
   * Saves the current filter state so it can be restored on disconnect.
   * Subsequent calls are no-ops.
   */
  saveBeforeUrlFilters(): void {
    if (!this._fromUrl) {
      this._previous = this._getFilters();
      this._fromUrl = true;
    }
  }
}
