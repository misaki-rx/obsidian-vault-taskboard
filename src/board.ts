import { MarkdownRenderChild, MarkdownRenderer, Menu, Notice, type App, type TFile } from "obsidian";
import { BoardWidth } from "./board-width";
import { ALL_CATEGORIES, CategoryModal, CREATE_CATEGORY, fillCategories } from "./category-ui";
import {
  stateKey, statusLabels, statuses, taskStatus,
  type Category, type Status, type Task, type TaskState,
} from "./model";
import type { CreatedTask, TaskDraft } from "./new-task";
import { NewTaskModal } from "./new-task-modal";

interface Controller {
  app: App;
  snapshot(): { tasks: Task[]; loading: boolean; failedReads: number };
  state(task: Task): TaskState | undefined;
  categories(): readonly Category[];
  subscribe(listener: () => void): () => void;
  move(tasks: Task[], status: Status): Promise<Task[]>;
  categorize(task: Task, category: Category | null, create: boolean): Promise<Category | null>;
  refresh(): Promise<void>;
  open(task: Task): Promise<void>;
  destinations(): TFile[];
  create(draft: TaskDraft): Promise<CreatedTask>;
  width(): number | undefined;
  saveWidth(width: number | undefined): Promise<void>;
}

interface Column {
  element: HTMLElement;
  count: HTMLElement;
  list: HTMLElement;
  empty: HTMLElement;
  more: HTMLButtonElement;
}

interface Card {
  element: HTMLElement;
  title: HTMLElement;
  source: HTMLButtonElement;
  checkbox: HTMLInputElement;
  category: HTMLSelectElement;
  handle: HTMLButtonElement;
  details: HTMLDetailsElement;
  summary: HTMLElement;
  body: HTMLElement;
  task: Task;
  status: Status;
  renderChild?: MarkdownRenderChild;
}

interface Drag {
  pointer: number;
  startX: number;
  startY: number;
  card: Card;
  ghost?: HTMLElement;
  destination?: HTMLElement;
}

const PAGE_SIZE = 60;
const labels: Record<Status, string> = {
  todo: "Select task",
  progress: "Complete task",
  done: "Reopen task",
};

export class Board extends MarkdownRenderChild {
  private widthFrame!: HTMLElement;
  private root!: HTMLElement;
  private message!: HTMLElement;
  private start!: HTMLButtonElement;
  private filter!: HTMLSelectElement;
  private readonly columns = new Map<Status, Column>();
  private readonly tabs = new Map<Status, HTMLButtonElement>();
  private readonly cards = new Map<string, Card>();
  private readonly selected = new Map<string, Task>();
  private readonly pending = new Set<string>();
  private readonly limits = new Map<Status, number>();
  private readonly recentTasks = new Set<string>();
  private categoryNames: readonly Category[] = [];
  private revealKey?: string;
  private active: Status = "todo";
  private frame?: number;
  private drag?: Drag;
  private suppressClickUntil = 0;
  private activeMenu?: Menu;
  private resize?: ResizeObserver;
  private closed = false;

  constructor(
    element: HTMLElement,
    private readonly controller: Controller,
  ) {
    super(element);
  }

  onload(): void {
    this.widthFrame = this.containerEl.createDiv({ cls: "pc-width-frame" });
    this.root = this.widthFrame.createDiv({ cls: "pc-board" });
    const toolbar = this.root.createDiv({ cls: "pc-toolbar" });
    const addTask = toolbar.createEl("button", {
      cls: "mod-cta pc-add-task",
      text: "+ New task",
      attr: { type: "button" },
    });
    addTask.addEventListener("click", () => this.openTaskForm());
    this.filter = toolbar.createEl("select", { attr: { "aria-label": "Filter by category" } });
    this.syncCategories();
    this.filter.addEventListener("change", () => this.onFilterChange());

    this.start = toolbar.createEl("button", {
      cls: "mod-cta pc-batch",
      attr: { type: "button" },
    });
    this.start.hidden = true;
    this.start.addEventListener("click", () => void this.move([...this.selected.values()], "progress"));

    const refresh = toolbar.createEl("button", {
      cls: "pc-refresh",
      text: "Refresh",
      attr: { type: "button" },
    });
    refresh.addEventListener("click", async () => {
      refresh.disabled = true;
      try {
        await this.controller.refresh();
      } finally {
        refresh.disabled = false;
      }
    });

    this.message = this.root.createDiv({ cls: "pc-message", attr: { role: "status" } });
    const tabs = this.root.createDiv({ cls: "pc-tabs", attr: { "aria-label": "Task columns" } });
    const columns = this.root.createDiv({ cls: "pc-columns" });

    for (const status of statuses) {
      const tab = tabs.createEl("button", {
        attr: { type: "button", "data-pc-drop": status },
      });
      tab.addEventListener("click", () => this.activate(status));
      this.tabs.set(status, tab);

      const element = columns.createEl("section", {
        cls: "pc-column",
        attr: { "aria-label": statusLabels[status], "data-pc-drop": status },
      });
      const heading = element.createDiv({ cls: "pc-column-header" });
      heading.createEl("h2", { cls: "pc-column-label", text: statusLabels[status] });
      const count = heading.createSpan({ cls: "pc-count" });
      const list = element.createDiv({ cls: "pc-cards" });
      const empty = element.createDiv({ cls: "pc-empty", text: "No tasks" });
      const more = element.createEl("button", {
        cls: "pc-more",
        attr: { type: "button" },
      });
      more.addEventListener("click", () => {
        this.limits.set(status, (this.limits.get(status) ?? PAGE_SIZE) + PAGE_SIZE);
        this.schedule();
      });
      this.columns.set(status, { element, count, list, empty, more });
    }

    this.activate("todo");
    this.addChild(new BoardWidth(this.widthFrame, this.root, toolbar, this.controller));
    this.register(this.controller.subscribe(() => this.schedule()));
    this.resize = new ResizeObserver(() => this.schedule());
    this.resize.observe(this.root);
    this.render();
  }

  onunload(): void {
    this.closed = true;
    this.cancelDrag();
    this.activeMenu?.hide();
    this.resize?.disconnect();
    if (this.frame !== undefined) this.window.cancelAnimationFrame(this.frame);
    this.widthFrame.remove();
  }

  private get window(): Window {
    return this.containerEl.ownerDocument.defaultView ?? window;
  }

  private activate(status: Status): void {
    this.active = status;
    for (const [key, column] of this.columns) {
      const active = key === status;
      column.element.classList.toggle("pc-active", active);
      this.tabs.get(key)?.setAttribute("aria-pressed", String(active));
    }
  }

  private schedule(): void {
    if (this.closed || this.frame !== undefined) return;
    this.frame = this.window.requestAnimationFrame(() => {
      this.frame = undefined;
      this.render();
    });
  }

  private onFilterChange(): void {
    this.limits.clear();
    this.selected.clear();
    this.revealKey = undefined;
    this.schedule();
  }

  private syncCategories(): void {
    const names = this.controller.categories();
    if (names.length === this.categoryNames.length &&
      names.every((name, index) => name === this.categoryNames[index])) return;
    this.categoryNames = names;
    fillCategories(this.filter, names, "filter");
    for (const card of this.cards.values()) fillCategories(card.category, names, "assign");
  }

  private openTaskForm(): void {
    new NewTaskModal(
      this.controller.app,
      this.categoryNames.includes(this.filter.value) ? this.filter.value : null,
      () => this.controller.categories(),
      () => this.controller.destinations(),
      async draft => this.onTaskCreated(await this.controller.create(draft)),
    ).open();
  }

  private onTaskCreated(created: CreatedTask): void {
    if (this.closed) {
      new Notice("Task created.");
      return;
    }

    this.recentTasks.add(stateKey(created.path, created.blockId));
    if (this.recentTasks.size > PAGE_SIZE) {
      const oldest = this.recentTasks.values().next();
      if (!oldest.done) this.recentTasks.delete(oldest.value);
    }

    const category = created.category ?? "";
    if (this.matchesFilter(category)) {
      this.activate("todo");
      this.schedule();
      return;
    }

    this.offerReveal("Task created.", category, "todo");
  }

  private matchesFilter(category: string): boolean {
    return this.filter.value === ALL_CATEGORIES || this.filter.value === category;
  }

  private offerReveal(messageText: string, category: string, status: Status, taskKey?: string): void {
    const message = this.containerEl.ownerDocument.createDocumentFragment();
    message.append(messageText + " ");
    const view = message.createEl("button", { text: "View task", attr: { type: "button" } });
    const notice = new Notice(message, 8000);
    view.addEventListener("click", () => {
      notice.hide();
      if (this.closed) return;
      this.syncCategories();
      this.filter.value = category;
      this.onFilterChange();
      this.revealKey = taskKey;
      this.activate(status);
      this.columns.get(status)?.element.scrollIntoView({ block: "nearest" });
    });
  }

  private render(): void {
    if (this.root.getClientRects().length === 0) return;
    this.syncCategories();
    const { tasks, loading, failedReads } = this.controller.snapshot();
    this.message.textContent = loading
      ? "Indexing tasks…"
      : failedReads ? `Could not read ${failedReads} note(s). Use Refresh to retry.` : "";
    this.message.hidden = !this.message.textContent;

    const groups: Record<Status, Task[]> = { todo: [], progress: [], done: [] };
    const validSelection = new Set<string>();
    const recent = new Map<string, Task>();
    let reveal: { task: Task; status: Status } | undefined;
    for (const task of tasks) {
      const state = this.controller.state(task);
      const status = taskStatus(task, state);
      if (!this.matchesFilter(state?.category ?? "")) continue;
      const createdKey = status === "todo" && this.recentTasks.size && task.blockId
        ? stateKey(task.path, task.blockId) : undefined;
      if (this.revealKey === task.key) reveal = { task, status };
      else if (createdKey && this.recentTasks.has(createdKey)) recent.set(createdKey, task);
      else groups[status].push(task);
      if (status === "todo" && this.selected.get(task.key) === task) validSelection.add(task.key);
    }
    for (const key of this.recentTasks) {
      const task = recent.get(key);
      if (task) groups.todo.unshift(task);
    }
    if (reveal) groups[reveal.status].unshift(reveal.task);
    for (const key of this.selected.keys()) {
      if (!validSelection.has(key)) this.selected.delete(key);
    }
    this.updateBatch();

    const visible = new Set<string>();
    for (const [status, column] of this.columns) {
      const items = groups[status];
      const limit = this.limits.get(status) ?? PAGE_SIZE;
      const amount = Math.min(limit, items.length);
      column.count.textContent = String(items.length);
      this.tabs.get(status)!.textContent = `${statusLabels[status]} ${items.length}`;
      column.empty.hidden = items.length > 0 || loading;
      column.more.hidden = amount >= items.length;
      column.more.textContent = `Show more (${items.length - amount})`;

      for (let index = 0; index < amount; index += 1) {
        const task = items[index];
        const card = this.cards.get(task.key) ?? this.createCard(task, status);
        this.updateCard(card, task, status);
        visible.add(task.key);
        const current = column.list.children.item(index);
        if (current !== card.element) column.list.insertBefore(card.element, current);
      }
      while (column.list.children.length > amount) column.list.lastElementChild?.remove();
    }

    for (const [key, card] of this.cards) {
      if (visible.has(key)) continue;
      if (this.drag?.card === card) this.cancelDrag();
      this.clearDetails(card);
      this.cards.delete(key);
    }
  }

  private updateBatch(): void {
    const count = this.selected.size;
    this.start.hidden = count === 0;
    this.start.disabled = [...this.selected.keys()].some(key => this.pending.has(key));
    this.start.textContent = count ? `Move ${count} to In Progress` : "";
  }

  private createCard(task: Task, status: Status): Card {
    const element = this.containerEl.ownerDocument.createElement("article");
    element.className = "pc-card";
    const details = element.createEl("details", { cls: "pc-details" });
    const summary = details.createEl("summary", { cls: "pc-summary" });
    const body = details.createDiv({ cls: "pc-details-body" });
    const content = element.createDiv({ cls: "pc-card-content" });
    const row = content.createDiv({ cls: "pc-card-row" });
    const checkbox = row.createEl("input", { attr: { type: "checkbox" } });
    const title = row.createDiv({ cls: "pc-title" });
    const handle = row.createEl("button", { cls: "pc-handle", text: "⠿", attr: { type: "button" } });

    const footer = content.createDiv({ cls: "pc-card-footer" });
    const category = footer.createEl("select", { cls: "pc-category" });
    fillCategories(category, this.categoryNames, "assign");
    const source = footer.createEl("button", { cls: "pc-source", attr: { type: "button" } });

    const card: Card = { element, title, source, checkbox, category, handle, details, summary, body, task, status };
    this.cards.set(task.key, card);
    checkbox.addEventListener("change", () => {
      if (card.status === "todo") {
        if (checkbox.checked) this.selected.set(card.task.key, card.task);
        else this.selected.delete(card.task.key);
        this.updateBatch();
      } else {
        checkbox.checked = card.status === "done";
        void this.move([card.task], card.status === "done" ? "todo" : "done");
      }
    });
    category.addEventListener("change", () => {
      const target = category.value;
      category.value = this.controller.state(card.task)?.category ?? "";
      const task = card.task;
      if (target === CREATE_CATEGORY) {
        new CategoryModal(
          this.controller.app,
          () => this.controller.categories(),
          (name, isNew) => this.assignCategory(task, name, isNew),
        ).open();
      } else {
        void this.assignCategory(task, target || null, false).catch(error => {
          new Notice(error instanceof Error ? error.message : "Could not update the task category.");
        });
      }
    });
    source.addEventListener("click", () => void this.controller.open(card.task));
    details.addEventListener("toggle", () => this.showDetails(card));
    handle.addEventListener("click", event => {
      if (event.detail && Date.now() < this.suppressClickUntil) return;
      this.showMoveMenu(card);
    });
    handle.addEventListener("pointerdown", event => this.beginDrag(event, card));
    handle.addEventListener("pointermove", event => this.updateDrag(event));
    handle.addEventListener("pointerup", event => this.finishDrag(event));
    handle.addEventListener("pointercancel", () => this.cancelDrag());
    handle.addEventListener("lostpointercapture", () => this.cancelDrag());
    return card;
  }

  private updateCard(card: Card, task: Task, status: Status): void {
    const previous = card.task;
    const title = task.title || "Untitled task";
    const busy = this.pending.has(task.key);
    card.task = task;
    card.status = status;
    card.title.textContent = title;
    card.checkbox.checked = status === "done" || this.selected.has(task.key);
    card.checkbox.disabled = busy;
    card.checkbox.setAttribute("aria-label", `${labels[status]}: ${title}`);
    card.handle.disabled = busy;
    card.handle.setAttribute("aria-label", `Move task: ${title}`);
    card.handle.title = "Drag to another column or open the move menu";
    card.category.disabled = busy;
    card.category.value = this.controller.state(task)?.category ?? "";
    card.category.setAttribute("aria-label", `Category: ${title}`);
    card.source.textContent = (task.path.split("/").pop() ?? task.path).replace(/\.md$/i, "");
    card.source.title = task.path;
    card.source.setAttribute("aria-label", `Open source note: ${task.path}`);
    card.details.hidden = !task.details;
    if (card.summary.textContent === "" || previous.details !== task.details) {
      card.summary.textContent = task.details;
      this.showDetails(card);
    }
  }

  private showDetails(card: Card): void {
    this.clearDetails(card);
    if (!card.details.open || !card.task.details) return;
    const output = card.body.createDiv();
    const component = this.addChild(new MarkdownRenderChild(output));
    card.renderChild = component;
    void MarkdownRenderer.render(
      this.controller.app, card.task.details, output, card.task.path, component,
    ).catch(error => {
      if (card.renderChild === component) output.textContent = card.task.details;
      console.warn("Progress Checker could not render task details", error);
    });
  }

  private clearDetails(card: Card): void {
    if (card.renderChild) {
      this.removeChild(card.renderChild);
      card.renderChild = undefined;
    }
    card.body.replaceChildren();
  }

  private showMoveMenu(card: Card): void {
    this.activeMenu?.hide();
    const menu = new Menu();
    for (const status of statuses) {
      if (status === card.status) continue;
      menu.addItem(item => item
        .setTitle(`Move to ${statusLabels[status]}`)
        .onClick(() => void this.move([card.task], status)));
    }
    const rect = card.handle.getBoundingClientRect();
    this.activeMenu = menu;
    menu.onHide(() => {
      if (this.activeMenu === menu) this.activeMenu = undefined;
    });
    menu.showAtPosition({ x: rect.left, y: rect.bottom });
  }

  private async assignCategory(task: Task, category: Category | null, create: boolean): Promise<void> {
    await this.run([task], async () => {
      const assigned = await this.controller.categorize(task, category, create);
      if (!this.closed && !this.matchesFilter(assigned ?? "")) {
        const status = taskStatus(task, this.controller.state(task));
        this.offerReveal("Category updated.", assigned ?? "", status, task.key);
      }
      return [task];
    });
  }

  private async run(tasks: Task[], operation: () => Promise<Task[]>): Promise<Task[]> {
    if (!tasks.length || tasks.some(task => this.pending.has(task.key))) return [];
    for (const task of tasks) this.pending.add(task.key);
    this.schedule();
    try {
      const successful = await operation();
      for (const task of successful) this.selected.delete(task.key);
      return successful;
    } finally {
      for (const task of tasks) this.pending.delete(task.key);
      this.schedule();
    }
  }

  private move(tasks: Task[], status: Status): Promise<Task[]> {
    return this.run(tasks, () => this.controller.move(tasks, status));
  }

  private beginDrag(event: PointerEvent, card: Card): void {
    if (!event.isPrimary || event.button !== 0 || this.drag || this.pending.has(card.task.key)) return;
    this.drag = { pointer: event.pointerId, startX: event.clientX, startY: event.clientY, card };
    card.handle.setPointerCapture(event.pointerId);
  }

  private updateDrag(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || drag.pointer !== event.pointerId) return;
    if (!drag.ghost) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
      drag.ghost = this.containerEl.ownerDocument.body.createDiv({
        cls: "pc-drag-ghost",
        text: drag.card.task.title || "Untitled task",
      });
      drag.card.element.classList.add("pc-dragging");
    }

    drag.ghost.style.transform = `translate(${event.clientX + 12}px, ${event.clientY + 12}px)`;
    const hit = this.containerEl.ownerDocument.elementFromPoint(event.clientX, event.clientY);
    const target = hit?.closest<HTMLElement>("[data-pc-drop]");
    const destination = target && this.root.contains(target) && target.dataset.pcDrop !== drag.card.status
      ? target : undefined;
    if (destination === drag.destination) return;
    drag.destination?.classList.remove("pc-drop-target");
    destination?.classList.add("pc-drop-target");
    drag.destination = destination;
  }

  private finishDrag(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || drag.pointer !== event.pointerId) return;
    if (drag.ghost) this.updateDrag(event);
    const target = statuses.find(status => status === drag.destination?.dataset.pcDrop);
    this.cancelDrag();
    if (target) {
      const active = this.active;
      void this.move([drag.card.task], target).then(moved => {
        if (moved.length && !this.closed && this.active === active) this.activate(target);
      });
    }
  }

  private cancelDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = undefined;
    if (drag.ghost) this.suppressClickUntil = Date.now() + 400;
    drag.ghost?.remove();
    drag.destination?.classList.remove("pc-drop-target");
    drag.card.element.classList.remove("pc-dragging");
    if (drag.card.handle.hasPointerCapture(drag.pointer)) {
      drag.card.handle.releasePointerCapture(drag.pointer);
    }
  }
}
