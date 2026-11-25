import { MarkdownRenderChild, MarkdownRenderer, Menu, Notice, setIcon, type App, type TFile } from "obsidian";
import { BoardWidth } from "./board-width";
import { ALL_CATEGORIES, CategoryModal, CREATE_CATEGORY, fillCategories } from "./category-ui";
import {
  stateKey, statusLabels, statuses, taskStatus,
  type Category, type Project, type ProjectChoice, type Status, type Task, type TaskState,
} from "./model";
import type { CreatedTask, TaskDraft } from "./new-task";
import { NewTaskModal } from "./new-task-modal";
import { ALL_PROJECTS, CREATE_PROJECT, fillProjects, NO_PROJECT, openProjectModal } from "./project-ui";

interface Controller {
  app: App;
  snapshot(): { tasks: Task[]; loading: boolean; failedReads: number };
  state(task: Task): TaskState | undefined;
  categories(): readonly Category[];
  projects(): readonly Project[];
  subscribe(listener: () => void): () => void;
  move(tasks: Task[], status: Status): Promise<Task[]>;
  categorize(task: Task, category: Category | null, create: boolean): Promise<Category | null>;
  setProject(task: Task, choice: ProjectChoice): Promise<string | null>;
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

interface Panel {
  id: string;
  element: HTMLElement;
  toggle: HTMLButtonElement;
  title: HTMLElement;
  count: HTMLElement;
  body: HTMLElement;
  columns: Map<Status, Column>;
  tabs: Map<Status, HTMLButtonElement>;
  limits: Map<Status, number>;
  active: Status;
}

type TaskGroups = Record<Status, Task[]>;

function emptyGroups(): TaskGroups {
  return { todo: [], progress: [], done: [] };
}

interface Card {
  element: HTMLElement;
  title: HTMLElement;
  source: HTMLButtonElement;
  checkbox: HTMLInputElement;
  category: HTMLSelectElement;
  project: HTMLSelectElement;
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
  private projectFilter!: HTMLSelectElement;
  private panelList!: HTMLElement;
  private readonly panels = new Map<string, Panel>();
  private readonly expanded = new Set<string>([""]);
  private readonly cards = new Map<string, Card>();
  private readonly selected = new Map<string, Task>();
  private readonly pending = new Set<string>();
  private readonly recentTasks = new Set<string>();
  private categoryNames: readonly Category[] = [];
  private projectList?: readonly Project[];
  private revealKey?: string;
  private scrollTarget?: string;
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
    this.projectFilter = toolbar.createEl("select", {
      cls: "pc-project-filter", attr: { "aria-label": "Filter by project" },
    });
    this.syncProjects();
    this.projectFilter.addEventListener("change", () => this.onFilterChange());
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
    this.panelList = this.root.createDiv({ cls: "pc-project-panels" });

    this.addChild(new BoardWidth(this.widthFrame, this.root, toolbar, this.controller));
    this.register(this.controller.subscribe(() => this.schedule()));
    this.resize = new ResizeObserver(() => this.schedule());
    this.resize.observe(this.root);
    this.render();
  }

  private createPanel(id: string): Panel {
    const element = this.panelList.createEl("section", { cls: "pc-project-panel" });
    element.dataset.pcProject = id;
    const header = element.createDiv({ cls: "pc-project-header" });
    const toggle = header.createEl("button", { cls: "pc-project-toggle", attr: { type: "button" } });
    setIcon(toggle.createSpan({ cls: "pc-project-icon" }), "folder");
    const title = toggle.createSpan({ cls: "pc-project-title" });
    const count = toggle.createSpan({ cls: "pc-project-count" });
    const add = header.createEl("button", {
      cls: "pc-project-add", text: "+ New task", attr: { type: "button" },
    });
    const body = element.createDiv({ cls: "pc-project-body" });
    const panel: Panel = {
      id, element, toggle, title, count, body,
      columns: new Map(), tabs: new Map(), limits: new Map(), active: "todo",
    };
    toggle.addEventListener("click", () => {
      if (this.projectFilter.value !== ALL_PROJECTS) return;
      if (this.expanded.has(id)) this.expanded.delete(id);
      else this.expanded.add(id);
      this.schedule();
    });
    add.addEventListener("click", () => this.openTaskForm(id || null));
    this.panels.set(id, panel);
    return panel;
  }

  private mountColumns(panel: Panel): void {
    if (panel.columns.size) return;
    const tabs = panel.body.createDiv({ cls: "pc-tabs", attr: { "aria-label": "Task columns" } });
    const columns = panel.body.createDiv({ cls: "pc-columns" });
    for (const status of statuses) {
      const tab = tabs.createEl("button", {
        attr: { type: "button", "data-pc-drop": status },
      });
      tab.addEventListener("click", () => this.activate(panel, status));
      panel.tabs.set(status, tab);

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
        panel.limits.set(status, (panel.limits.get(status) ?? PAGE_SIZE) + PAGE_SIZE);
        this.schedule();
      });
      panel.columns.set(status, { element, count, list, empty, more });
    }
    this.activate(panel, panel.active);
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

  private activate(panel: Panel, status: Status): void {
    panel.active = status;
    for (const [key, column] of panel.columns) {
      const active = key === status;
      column.element.classList.toggle("pc-active", active);
      panel.tabs.get(key)?.setAttribute("aria-pressed", String(active));
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
    for (const panel of this.panels.values()) panel.limits.clear();
    this.selected.clear();
    this.revealKey = undefined;
    this.scrollTarget = undefined;
    this.schedule();
  }

  private syncProjects(): void {
    const projects = this.controller.projects();
    if (projects === this.projectList) return;
    this.projectList = projects;
    fillProjects(this.projectFilter, projects, "filter");
    for (const card of this.cards.values()) fillProjects(card.project, projects, "assign");
  }

  private syncCategories(): void {
    const names = this.controller.categories();
    if (names.length === this.categoryNames.length &&
      names.every((name, index) => name === this.categoryNames[index])) return;
    this.categoryNames = names;
    fillCategories(this.filter, names, "filter");
    for (const card of this.cards.values()) fillCategories(card.category, names, "assign");
  }

  private openTaskForm(project = this.projectFilter.value === ALL_PROJECTS ? null : this.projectFilter.value || null): void {
    new NewTaskModal(
      this.controller.app,
      this.categoryNames.includes(this.filter.value) ? this.filter.value : null,
      () => this.controller.categories(),
      project,
      () => this.controller.projects(),
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
    const project = created.projectId ?? "";
    if (this.matchesFilter(category) && this.matchesProject(project)) {
      this.showPanel(project, "todo");
      return;
    }

    this.offerReveal("Task created.", category, project, "todo");
  }

  private matchesFilter(category: string): boolean {
    return this.filter.value === ALL_CATEGORIES || this.filter.value === category;
  }

  private matchesProject(project: string): boolean {
    return this.projectFilter.value === ALL_PROJECTS || this.projectFilter.value === project;
  }

  private showPanel(project: string, status: Status, taskKey?: string): void {
    this.expanded.add(project);
    const panel = this.panels.get(project) ?? this.createPanel(project);
    this.activate(panel, status);
    this.revealKey = taskKey;
    this.scrollTarget = project;
    this.schedule();
  }

  private offerReveal(messageText: string, category: string, project: string, status: Status, taskKey?: string): void {
    const message = this.containerEl.ownerDocument.createDocumentFragment();
    message.append(messageText + " ");
    const view = message.createEl("button", { text: "View task", attr: { type: "button" } });
    const notice = new Notice(message, 8000);
    view.addEventListener("click", () => {
      notice.hide();
      if (this.closed) return;
      this.syncCategories();
      this.syncProjects();
      if (!this.matchesFilter(category)) this.filter.value = category;
      if (!this.matchesProject(project)) this.projectFilter.value = project;
      this.onFilterChange();
      this.showPanel(project, status, taskKey);
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

    this.syncProjects();
    const groupsByProject = new Map<string, TaskGroups>();
    const groupsFor = (id: string) => {
      let groups = groupsByProject.get(id);
      if (!groups) {
        groups = emptyGroups();
        groupsByProject.set(id, groups);
      }
      return groups;
    };
    const single = this.projectFilter.value !== ALL_PROJECTS;
    const validSelection = new Set<string>();
    const recent = new Map<string, { task: Task; project: string }>();
    let reveal: { task: Task; status: Status; project: string } | undefined;
    for (const task of tasks) {
      const state = this.controller.state(task);
      const project = state?.projectId ?? "";
      if (!this.matchesFilter(state?.category ?? "") || !this.matchesProject(project)) continue;
      const status = taskStatus(task, state);
      const createdKey = status === "todo" && this.recentTasks.size && task.blockId
        ? stateKey(task.path, task.blockId) : undefined;
      if (this.revealKey === task.key) reveal = { task, status, project };
      else if (createdKey && this.recentTasks.has(createdKey)) recent.set(createdKey, { task, project });
      else groupsFor(project)[status].push(task);
      if (status === "todo" && (single || this.expanded.has(project)) &&
        this.selected.get(task.key) === task) validSelection.add(task.key);
    }
    for (const key of this.recentTasks) {
      const created = recent.get(key);
      if (created) groupsFor(created.project).todo.unshift(created.task);
    }
    if (reveal) groupsFor(reveal.project)[reveal.status].unshift(reveal.task);
    for (const key of this.selected.keys()) {
      if (!validSelection.has(key)) this.selected.delete(key);
    }
    this.updateBatch();

    const visible = new Set<string>();
    const projectList = [{ id: "", name: NO_PROJECT }, ...(this.projectList ?? [])];
    for (const { id, name } of projectList) {
      if (!this.matchesProject(id) && !this.panels.has(id)) continue;
      const panel = this.panels.get(id) ?? this.createPanel(id);
      const groups = groupsFor(id);
      const shown = this.matchesProject(id);
      const open = shown && (single || this.expanded.has(id));
      panel.element.hidden = !shown;
      panel.body.hidden = !open;
      panel.toggle.disabled = single;
      panel.toggle.setAttribute("aria-expanded", String(open));
      panel.title.textContent = name;
      panel.count.textContent = statuses.map(status => `${statusLabels[status]} ${groups[status].length}`).join(" · ");
      if (open) this.renderColumns(panel, groups, loading, visible);
      else {
        for (const column of panel.columns.values()) {
          if (column.list.childElementCount) column.list.replaceChildren();
        }
      }
    }
    if (this.scrollTarget !== undefined) {
      const target = this.revealKey && this.cards.get(this.revealKey)?.element;
      const element = target || this.panels.get(this.scrollTarget)?.element;
      element?.scrollIntoView({ block: "nearest" });
      this.scrollTarget = undefined;
    }

    for (const [key, card] of this.cards) {
      if (visible.has(key)) continue;
      if (this.drag?.card === card) this.cancelDrag();
      this.clearDetails(card);
      this.cards.delete(key);
    }
  }

  private renderColumns(panel: Panel, groups: TaskGroups, loading: boolean, visible: Set<string>): void {
    this.mountColumns(panel);
    for (const [status, column] of panel.columns) {
      const items = groups[status];
      const limit = panel.limits.get(status) ?? PAGE_SIZE;
      const amount = Math.min(limit, items.length);
      column.count.textContent = String(items.length);
      panel.tabs.get(status)!.textContent = `${statusLabels[status]} ${items.length}`;
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
    const projectField = footer.createDiv({ cls: "pc-card-project" });
    setIcon(projectField.createSpan({ cls: "pc-project-icon" }), "folder");
    const project = projectField.createEl("select", { cls: "pc-task-project" });
    fillProjects(project, this.projectList ?? [], "assign");
    const source = footer.createEl("button", { cls: "pc-source", attr: { type: "button" } });

    const card: Card = { element, title, source, checkbox, category, project, handle, details, summary, body, task, status };
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
    project.addEventListener("change", () => {
      const target = project.value;
      const task = card.task;
      project.value = this.controller.state(task)?.projectId ?? "";
      if (target === CREATE_PROJECT) {
        openProjectModal(this.controller.app, () => this.controller.projects(), choice => this.assignProject(task, choice));
      } else {
        void this.assignProject(task, target || null).catch(error => {
          new Notice(error instanceof Error ? error.message : "Could not update the task project.");
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
    const state = this.controller.state(task);
    card.category.value = state?.category ?? "";
    card.category.setAttribute("aria-label", `Category: ${title}`);
    card.project.disabled = busy;
    card.project.value = state?.projectId ?? "";
    card.project.setAttribute("aria-label", `Project: ${title}`);
    card.project.title = card.project.selectedOptions[0]?.textContent ?? NO_PROJECT;
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
        const state = this.controller.state(task);
        this.offerReveal("Category updated.", assigned ?? "", state?.projectId ?? "", taskStatus(task, state), task.key);
      }
      return [task];
    });
  }

  private async assignProject(task: Task, choice: ProjectChoice): Promise<void> {
    const previous = this.controller.state(task)?.projectId ?? "";
    await this.run([task], async () => {
      const project = await this.controller.setProject(task, choice) ?? "";
      if (!this.closed && project !== previous) {
        const state = this.controller.state(task);
        const status = taskStatus(task, state);
        if (this.matchesProject(project)) this.showPanel(project, status, task.key);
        else this.offerReveal("Project updated.", state?.category ?? "", project, status, task.key);
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
    const sourcePanel = drag.card.element.closest(".pc-project-panel");
    const destination = target && sourcePanel && sourcePanel.contains(target) && target.dataset.pcDrop !== drag.card.status
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
    const panel = this.panels.get(this.controller.state(drag.card.task)?.projectId ?? "");
    this.cancelDrag();
    if (target && panel) {
      const active = panel.active;
      void this.move([drag.card.task], target).then(moved => {
        if (moved.length && !this.closed && panel.active === active) this.activate(panel, target);
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
