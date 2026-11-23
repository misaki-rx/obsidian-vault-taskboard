import { Component } from "obsidian";

interface WidthSettings {
  width(): number | undefined;
  saveWidth(width: number | undefined): Promise<void>;
  subscribe(listener: () => void): () => void;
}

const MIN_WIDTH = 640;
const KEY_STEP = 40;
const EDITOR_WIDGET_GUTTER = 4;

export class BoardWidth extends Component {
  private handle!: HTMLElement;
  private fit!: HTMLButtonElement;
  private observer?: ResizeObserver;
  private pane?: HTMLElement;
  private editorWidget?: HTMLElement;
  private maximum = 0;
  private actual = 0;
  private preferred?: number;
  private draft?: number | null;
  private revision = 0;
  private drag?: { pointer: number; x: number; width: number };
  private closed = false;

  constructor(
    private readonly frame: HTMLElement,
    private readonly board: HTMLElement,
    private readonly toolbar: HTMLElement,
    private readonly settings: WidthSettings,
  ) {
    super();
  }

  onload(): void {
    this.preferred = this.settings.width();
    this.handle = this.board.createDiv({
      cls: "pc-resize-handle",
      attr: {
        role: "slider",
        tabindex: "0",
        "aria-label": "Board width",
        title: "Drag to resize the board. Double-click to fit the window.",
      },
    });
    this.fit = this.toolbar.createEl("button", {
      cls: "pc-fit-width",
      text: "Fit width",
      attr: { type: "button", title: "Fit the board to the current pane" },
    });

    this.handle.addEventListener("pointerdown", event => {
      if (!event.isPrimary || event.button !== 0 || this.drag) return;
      this.drag = { pointer: event.pointerId, x: event.clientX, width: this.actual };
      this.handle.setPointerCapture(event.pointerId);
      this.board.classList.add("pc-resizing");
    });
    this.handle.addEventListener("pointermove", event => {
      if (this.drag?.pointer !== event.pointerId) return;
      const change = 2 * (event.clientX - this.drag.x);
      this.draft = this.clamp(this.drag.width + change);
      this.layout();
    });
    this.handle.addEventListener("pointerup", event => {
      if (this.drag?.pointer !== event.pointerId) return;
      const previous = this.drag.width;
      this.finishDrag();
      if (previous !== this.actual) this.save(this.actual);
      else this.resetDraft();
    });
    this.handle.addEventListener("lostpointercapture", () => this.cancelDrag());
    this.handle.addEventListener("pointercancel", () => this.cancelDrag());
    this.handle.addEventListener("dblclick", () => this.save(undefined));
    this.handle.addEventListener("keydown", event => this.resizeWithKey(event));
    this.fit.addEventListener("click", () => this.save(undefined));

    this.register(this.settings.subscribe(() => {
      const preferred = this.settings.width();
      if (preferred === this.preferred) return;
      this.preferred = preferred;
      this.layout();
    }));
    this.observer = new ResizeObserver(() => this.layout());
    this.observer.observe(this.frame);
    this.layout();
  }

  onunload(): void {
    this.closed = true;
    this.observer?.disconnect();
    this.finishDrag();
    this.clearEditorWidget();
  }

  private clamp(width: number): number {
    return Math.min(this.maximum, Math.max(MIN_WIDTH, Math.round(width)));
  }

  private layout(): void {
    if (this.closed || !this.frame.getClientRects().length) return;
    const pane = this.frame.closest<HTMLElement>(".markdown-preview-view, .cm-scroller, .workspace-leaf-content") ?? this.frame;
    if (pane !== this.pane) {
      if (this.pane && this.pane !== this.frame) this.observer?.unobserve(this.pane);
      if (pane !== this.frame) this.observer?.observe(pane);
      this.pane = pane;
    }
    const viewport = pane.getBoundingClientRect();
    const available = pane.clientWidth;
    const gutter = available < 680 ? 12 : 22;
    const left = viewport.left + pane.clientLeft;
    const center = left + available / 2;
    this.maximum = Math.max(0, available - gutter * 2);
    if (!this.maximum) return;
    this.layoutEditorWidget(left, available);
    const preferred = this.draft === undefined ? this.preferred : this.draft;
    this.actual = this.clamp(preferred ?? this.maximum);
    this.board.style.width = `${this.actual}px`;
    this.board.style.marginLeft = `${center - this.frame.getBoundingClientRect().left - this.actual / 2}px`;
    this.handle.hidden = this.maximum <= MIN_WIDTH;
    this.handle.setAttribute("aria-valuemin", String(Math.min(MIN_WIDTH, this.maximum)));
    this.handle.setAttribute("aria-valuemax", String(this.maximum));
    this.handle.setAttribute("aria-valuenow", String(this.actual));
    this.handle.setAttribute("aria-valuetext", `${this.actual} pixels`);
    this.fit.hidden = preferred == null;
  }

  private layoutEditorWidget(left: number, width: number): void {
    const widget = this.frame.closest<HTMLElement>(
      ".markdown-source-view.is-live-preview .cm-embed-block.cm-lang-progress-check",
    ) ?? undefined;
    if (widget !== this.editorWidget) {
      this.clearEditorWidget();
      this.editorWidget = widget;
    }
    const parent = widget?.parentElement;
    if (!widget || !parent) return;

    const parentLeft = parent.getBoundingClientRect().left + parent.clientLeft;
    widget.style.setProperty("--pc-widget-width", `${width - EDITOR_WIDGET_GUTTER * 2}px`);
    widget.style.setProperty("--pc-widget-offset", `${left + EDITOR_WIDGET_GUTTER - parentLeft}px`);
    widget.classList.add("pc-wide-widget");
  }

  private clearEditorWidget(): void {
    if (!this.editorWidget) return;
    this.editorWidget.classList.remove("pc-wide-widget");
    this.editorWidget.style.removeProperty("--pc-widget-width");
    this.editorWidget.style.removeProperty("--pc-widget-offset");
    this.editorWidget = undefined;
  }

  private resizeWithKey(event: KeyboardEvent): void {
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight":
        this.save(this.clamp(this.actual + (event.key === "ArrowLeft" ? -KEY_STEP : KEY_STEP)));
        break;
      case "Home":
        this.save(this.clamp(MIN_WIDTH));
        break;
      case "End":
        this.save(undefined);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  private cancelDrag(): void {
    if (!this.drag) return;
    this.finishDrag();
    this.resetDraft();
  }

  private finishDrag(): void {
    if (!this.drag) return;
    const { pointer } = this.drag;
    this.drag = undefined;
    this.board.classList.remove("pc-resizing");
    if (this.handle.hasPointerCapture(pointer)) this.handle.releasePointerCapture(pointer);
  }

  private resetDraft(): void {
    this.draft = undefined;
    this.layout();
  }

  private save(width: number | undefined): void {
    const revision = ++this.revision;
    this.draft = width ?? null;
    this.layout();
    void this.settings.saveWidth(width).finally(() => {
      if (revision === this.revision && !this.drag) this.resetDraft();
    });
  }
}
