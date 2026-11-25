import { MarkdownView, Notice, Plugin, TFile, TFolder } from "obsidian";
import type { TAbstractFile } from "obsidian";
import { Board } from "./src/board";
import { appendTask, DEFAULT_INBOX, taskTitle, type CreatedTask, type TaskDraft } from "./src/new-task";
import {
  builtInCategories, categoryName, editTaskLines, findCategory, hasBoardBlock, labelKey,
  projectName, stateKey, taskStatus,
  type Category, type LineEdit, type Project, type ProjectChoice, type Status, type Task, type TaskState,
} from "./src/model";
import { TaskIndex } from "./src/task-index";

const DEFAULT_BOARD = "Progress Check.md";
const BOARD_BLOCK = "```progress-check\n```\n";

interface BoardData {
  boardPath: string;
  boardWidth?: number;
  customCategories: Category[];
  projects: Project[];
  tasks: Record<string, TaskState>;
}

type Change = { status: Status } | { category: Category | null } | { projectId: string | null };

function restoreData(raw: unknown): BoardData {
  const data = raw as Partial<BoardData> | null;
  const customCategories: Category[] = [];
  if (Array.isArray(data?.customCategories)) {
    for (const entry of data.customCategories) {
      if (typeof entry !== "string") continue;
      try {
        const name = categoryName(entry);
        if (findCategory(builtInCategories, name) || findCategory(customCategories, name)) continue;
        customCategories.push(name);
      } catch {
        // Ignore malformed category names from stored data.
      }
    }
  }
  const available = [...builtInCategories, ...customCategories];
  const projects: Project[] = [];
  const projectIds = new Set<string>();
  const projectNames = new Set<string>();
  if (Array.isArray(data?.projects)) {
    for (const project of data.projects) {
      if (typeof project?.id !== "string" || !/^project-[a-f0-9]{16}$/.test(project.id) ||
        typeof project.name !== "string" || projectIds.has(project.id)) continue;
      try {
        const name = projectName(project.name);
        const key = labelKey(name);
        if (projectNames.has(key)) continue;
        projectIds.add(project.id);
        projectNames.add(key);
        projects.push({ id: project.id, name });
      } catch {
        // Ignore malformed project names from stored data.
      }
    }
  }
  const tasks: Record<string, TaskState> = {};
  for (const [key, value] of Object.entries(data?.tasks ?? {})) {
    let pair: unknown;
    try {
      pair = JSON.parse(key);
    } catch {
      continue;
    }
    if (
      !Array.isArray(pair) || pair.length !== 2 ||
      typeof pair[0] !== "string" || typeof pair[1] !== "string"
    ) continue;
    const state: TaskState = {};
    if (value?.progress === true) state.progress = true;
    if (typeof value?.category === "string") state.category = findCategory(available, value.category);
    if (typeof value?.projectId === "string" && projectIds.has(value.projectId)) state.projectId = value.projectId;
    if (state.progress || state.category || state.projectId) tasks[stateKey(pair[0], pair[1])] = state;
  }
  const boardWidth = typeof data?.boardWidth === "number" &&
    Number.isFinite(data.boardWidth) && data.boardWidth > 0 ? data.boardWidth : undefined;
  return { boardPath: data?.boardPath || DEFAULT_BOARD, boardWidth, customCategories, projects, tasks };
}

export default class ProgressChecker extends Plugin {
  private data: BoardData = { boardPath: DEFAULT_BOARD, customCategories: [], projects: [], tasks: {} };
  private index!: TaskIndex;
  private readonly listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private loaded = true;

  async onload(): Promise<void> {
    this.data = restoreData(await this.loadData());
    this.index = new TaskIndex(this.app, path => path === this.data.boardPath, () => this.notify());

    this.registerMarkdownCodeBlockProcessor("progress-check", (_source, element, context) => {
      context.addChild(new Board(element, {
        app: this.app,
        snapshot: () => ({
          tasks: this.index.all(),
          loading: this.index.loading,
          failedReads: this.index.failedReads,
        }),
        state: task => this.stateFor(task),
        categories: () => this.categoryNames(),
        projects: () => this.data.projects,
        subscribe: listener => {
          this.listeners.add(listener);
          return () => this.listeners.delete(listener);
        },
        move: (tasks, status) => this.change(tasks, { status }),
        categorize: (task, category, create) => this.setTaskCategory(task, category, create),
        setProject: (task, choice) => this.setTaskProject(task, choice),
        refresh: () => this.index.refresh(),
        open: task => this.openTask(task),
        destinations: () => this.app.vault.getMarkdownFiles()
          .filter(file => this.isTaskDestination(file.path, context.sourcePath)),
        create: draft => this.enqueue(() => this.createTask(draft, context.sourcePath)),
        width: () => this.data.boardWidth,
        saveWidth: width => this.enqueue(async () => {
          if (width === this.data.boardWidth) return;
          const next = { ...this.data, boardWidth: width };
          await this.saveData(next);
          this.data = next;
          this.notify();
        }).catch(error => this.report("Could not save the board width", error)),
      }));
      this.app.workspace.onLayoutReady(() => {
        if (this.loaded) void this.index.start();
      });
    });

    this.addCommand({
      id: "open-board",
      name: "Open board",
      callback: () => {
        void this.enqueue(() => this.openBoard()).catch(error => this.report("Could not open the board", error));
      },
    });

    this.registerEvent(this.app.metadataCache.on("changed", (file, source, metadata) => {
      if (this.index.started) this.index.accept(file, source, metadata);
    }));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onRename(file, oldPath)));
    this.registerEvent(this.app.vault.on("delete", file => this.onDelete(file)));
  }

  onunload(): void {
    this.loaded = false;
    this.index?.stop();
    this.listeners.clear();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      if (!this.loaded) throw new Error("Progress Checker is disabled.");
      return work();
    });
    this.queue = result.catch(() => {});
    return result;
  }

  private report(message: string, error: unknown): void {
    console.warn(`Progress Checker: ${message}`, error);
    new Notice(`Progress Checker: ${message}.`);
  }

  private async openBoard(): Promise<void> {
    const path = this.data.boardPath;
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFolder) throw new Error("The board path is a folder.");
    let file = existing instanceof TFile ? existing : null;
    if (file) {
      const current = await this.app.vault.cachedRead(file);
      if (!hasBoardBlock(current)) {
        await this.app.vault.process(file, source => hasBoardBlock(source)
          ? source
          : source + (source.length ? "\n\n" : "") + BOARD_BLOCK);
      }
    } else {
      file = await this.app.vault.create(path, BOARD_BLOCK);
    }
    await this.app.workspace.getLeaf(false).openFile(file, { state: { mode: "preview" } });
  }

  private async openTask(task: Task): Promise<void> {
    const file = this.app.vault.getFileByPath(task.path);
    if (!file) {
      new Notice("Progress Checker: the source note is no longer available.");
      return;
    }
    try {
      const leaf = this.app.workspace.getLeaf(false);
      const anchor = task.blockId && this.app.metadataCache.getFileCache(file)?.blocks?.[task.blockId];
      if (anchor && anchor.position.start.line === task.line) {
        await leaf.openFile(file, { eState: { subpath: `#^${task.blockId}` } });
      } else {
        await leaf.openFile(file, { eState: { line: task.line } });
        if (leaf.view instanceof MarkdownView && leaf.view.getMode() === "source") {
          const cursor = { line: task.line, ch: 0 };
          leaf.view.editor.setCursor(cursor);
          leaf.view.editor.scrollIntoView({ from: cursor, to: cursor }, true);
        }
      }
    } catch (error) {
      this.report(`Could not open ${task.path}`, error);
    }
  }

  private stateFor(task: Task): TaskState | undefined {
    return task.blockId ? this.data.tasks[stateKey(task.path, task.blockId)] : undefined;
  }

  private categoryNames(): readonly Category[] {
    return [...builtInCategories, ...this.data.customCategories];
  }

  private resolveCategory(requested: Category | null, allowCreate = false): {
    category: Category | null;
    customCategories?: Category[];
  } {
    if (requested === null) return { category: null };
    const existing = findCategory(this.categoryNames(), requested);
    if (existing) return { category: existing };
    if (!allowCreate) throw new Error("This category is no longer available.");
    const category = categoryName(requested);
    return { category, customCategories: [...this.data.customCategories, category] };
  }

  private setTaskCategory(task: Task, requested: Category | null, create: boolean): Promise<Category | null> {
    return this.enqueue(async () => {
      const { category, customCategories } = this.resolveCategory(requested, create);
      await this.updateTaskMetadata(task, { category }, { customCategories });
      return category;
    });
  }

  private resolveProject(choice: ProjectChoice): { projectId: string | null; projects?: Project[] } {
    if (choice === null) return { projectId: null };
    if (typeof choice === "string") {
      if (!this.data.projects.some(project => project.id === choice)) {
        throw new Error("This project is no longer available.");
      }
      return { projectId: choice };
    }
    const name = projectName(choice.name);
    const existing = this.data.projects.find(project => labelKey(project.name) === labelKey(name));
    if (existing) return { projectId: existing.id };
    let id: string;
    do { id = this.randomId("project"); } while (this.data.projects.some(project => project.id === id));
    return { projectId: id, projects: [...this.data.projects, { id, name }] };
  }

  private setTaskProject(task: Task, choice: ProjectChoice): Promise<string | null> {
    return this.enqueue(async () => {
      const { projectId, projects } = this.resolveProject(choice);
      await this.updateTaskMetadata(task, { projectId }, { projects });
      return projectId;
    });
  }

  private async updateTaskMetadata(
    task: Task,
    change: Change,
    registries: Partial<Pick<BoardData, "customCategories" | "projects">>,
  ): Promise<void> {
    try {
      await this.changeNote(task.path, [task], change, registries);
    } catch (error) {
      const file = this.app.vault.getFileByPath(task.path);
      if (file) void this.index.read(file);
      throw error;
    }
  }

  private isTaskDestination(path: string, boardPath: string): boolean {
    return path !== boardPath && path !== this.data.boardPath;
  }

  private async createTask(draft: TaskDraft, boardPath: string): Promise<CreatedTask> {
    const title = taskTitle(draft.title);
    const { category, customCategories } = this.resolveCategory(draft.category, draft.createCategory);
    const { projectId, projects } = this.resolveProject(draft.project);
    const path = draft.destination?.path ?? DEFAULT_INBOX;
    if (!this.isTaskDestination(path, boardPath)) {
      throw new Error("Choose a note other than the board.");
    }

    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing && !(existing instanceof TFile)) {
      throw new Error("The inbox path is already a folder. Choose another note.");
    }
    const file = existing instanceof TFile ? existing : null;
    if (draft.destination && file !== draft.destination) {
      throw new Error("The selected note is no longer available. Choose another note.");
    }

    const current = file ? await this.app.vault.read(file) : "";
    if (file) this.validateSource(file, path, current, current);
    const blockId = this.makeBlockId(current);
    const content = appendTask(current, title, blockId);
    const next = category || projectId ? {
      ...this.data,
      customCategories: customCategories ?? this.data.customCategories,
      projects: projects ?? this.data.projects,
      tasks: {
        ...this.data.tasks,
        [stateKey(path, blockId)]: { category: category ?? undefined, projectId: projectId ?? undefined },
      },
    } : undefined;

    await this.persistTaskChange(next, async () => {
      if (file) {
        await this.app.vault.process(file, source => {
          this.validateSource(file, path, source, current);
          return content;
        });
      } else {
        await this.app.vault.create(path, content);
      }
    });
    return { path, blockId, category, projectId: projectId ?? undefined };
  }

  private change(tasks: Task[], change: Change): Promise<Task[]> {
    return this.enqueue(async () => {
      const byPath = new Map<string, Task[]>();
      for (const task of tasks) {
        const group = byPath.get(task.path) ?? [];
        group.push(task);
        byPath.set(task.path, group);
      }

      const changed: Task[] = [];
      let failure: unknown;
      for (const [path, group] of byPath) {
        try {
          await this.changeNote(path, group, change);
          changed.push(...group);
        } catch (error) {
          failure = error;
          const file = this.app.vault.getFileByPath(path);
          if (file) void this.index.read(file);
        }
      }
      if (failure) {
        this.report(`Could not update ${tasks.length - changed.length} task(s). Refresh the board and try again`, failure);
      }
      return changed;
    }).catch(error => {
      this.report("Could not update the board", error);
      return [];
    });
  }

  private async changeNote(
    path: string,
    tasks: Task[],
    change: Change,
    registries: Partial<Pick<BoardData, "customCategories" | "projects">> = {},
  ): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    const note = this.index.notes.get(path);
    if (!file || !note || tasks.some(task => !note.tasks.includes(task))) {
      throw new Error("The task list changed.");
    }

    const counts = new Map<string, number>();
    for (const { blockId } of note.tasks) {
      if (blockId) counts.set(blockId, (counts.get(blockId) ?? 0) + 1);
    }

    const previous = this.data;
    const next: BoardData = {
      ...previous,
      customCategories: registries.customCategories ?? previous.customCategories,
      projects: registries.projects ?? previous.projects,
      tasks: { ...previous.tasks },
    };
    const edits: LineEdit[] = [];
    let stateChanged = Boolean(registries.customCategories || registries.projects);
    for (const task of tasks) {
      const old = this.stateFor(task);
      const state = { ...old };
      let marker = task.marker;

      if ("status" in change) {
        const target = change.status;
        if (taskStatus(task, old) === target) continue;
        marker = target === "done" ? "x" : " ";
        if (target === "progress") state.progress = true;
        else delete state.progress;
      } else if ("category" in change) {
        if (old?.category === (change.category ?? undefined)) continue;
        if (change.category) state.category = change.category;
        else delete state.category;
      } else {
        if (old?.projectId === (change.projectId ?? undefined)) continue;
        if (change.projectId) state.projectId = change.projectId;
        else delete state.projectId;
      }

      if (task.blockId && (counts.get(task.blockId) ?? 0) > 1) {
        throw new Error("Multiple source tasks have the same block ID.");
      }
      const needsId = !task.blockId && (state.progress || state.category || state.projectId);
      const newBlockId = needsId ? this.makeBlockId(note.source) : undefined;
      const blockId = task.blockId ?? newBlockId;
      if (blockId && (state.progress !== old?.progress || state.category !== old?.category ||
        state.projectId !== old?.projectId)) {
        const key = stateKey(path, blockId);
        if (state.progress || state.category || state.projectId) next.tasks[key] = state;
        else delete next.tasks[key];
        stateChanged = true;
      }
      if (newBlockId || marker !== task.marker) edits.push({ task, marker, newBlockId });
    }

    if (!edits.length && !stateChanged) return;
    if (stateChanged) {
      const latest = await this.app.vault.read(file);
      this.validateSource(file, path, latest, note.source);
    }
    await this.persistTaskChange(stateChanged ? next : undefined, async () => {
      if (!edits.length) return;
      const source = await this.app.vault.process(file, current => {
        this.validateSource(file, path, current, note.source);
        return editTaskLines(current, edits);
      });
      const indexed = this.index.notes.get(path);
      if (file.path === path && indexed === note) this.index.accept(file, source, note.metadata);
    });
  }

  private async persistTaskChange(next: BoardData | undefined, write: () => Promise<void>): Promise<void> {
    const previous = this.data;
    // Stage metadata first so a source write failure can restore the prior state.
    if (next) await this.saveData(next);
    try {
      await write();
    } catch (error) {
      if (next) {
        try {
          await this.saveData(previous);
        } catch (rollbackError) {
          this.report("Could not restore saved task metadata", rollbackError);
        }
      }
      throw error;
    }

    if (next) this.data = next;
    this.notify();
  }

  private validateSource(file: TFile, path: string, current: string, indexed: string): void {
    if (file.path !== path || current !== indexed) throw new Error("The source note changed.");
    this.app.workspace.iterateAllLeaves(leaf => {
      const view = leaf.view;
      if (
        view instanceof MarkdownView && view.file === file && view.getMode() === "source" &&
        view.editor.getValue() !== current.replace(/\r\n|\r/g, "\n")
      ) {
        throw new Error("The source note has unsaved edits.");
      }
    });
  }

  private makeBlockId(source: string): string {
    let id: string;
    do { id = this.randomId("pc"); } while (source.includes(`^${id}`));
    return id;
  }

  private randomId(prefix: string): string {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return prefix + "-" + Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  }

  private onRename(file: TAbstractFile, oldPath: string): void {
    const newPath = file.path;
    const folder = file instanceof TFolder;
    if (this.index.started) {
      if (file instanceof TFile) this.index.move(oldPath, file);
      else if (folder) {
        for (const note of this.app.vault.getMarkdownFiles()) {
          if (note.path.startsWith(newPath + "/")) {
            this.index.move(oldPath + note.path.slice(newPath.length), note);
          }
        }
      }
    }
    void this.enqueue(() => this.remapPaths(oldPath, folder, newPath))
      .catch(error => this.report("Could not update metadata after a rename", error));
  }

  private onDelete(file: TAbstractFile): void {
    const path = file.path;
    const folder = file instanceof TFolder;
    for (const indexed of this.index.notes.keys()) {
      if (indexed === path || (folder && indexed.startsWith(path + "/"))) this.index.remove(indexed);
    }
    void this.enqueue(() => this.remapPaths(path, folder))
      .catch(error => this.report("Could not remove metadata for a deleted note", error));
  }

  private async remapPaths(path: string, folder: boolean, destination?: string): Promise<void> {
    const matches = (entry: string) => entry === path || (folder && entry.startsWith(path + "/"));
    const previous = this.data;
    const next: BoardData = { ...previous, tasks: {} };
    let changed = false;
    for (const [key, state] of Object.entries(previous.tasks)) {
      const [taskPath, id] = JSON.parse(key) as [string, string];
      if (!matches(taskPath)) {
        next.tasks[key] = state;
        continue;
      }
      changed = true;
      if (destination) next.tasks[stateKey(destination + taskPath.slice(path.length), id)] = state;
    }
    if (matches(previous.boardPath)) {
      next.boardPath = destination ? destination + previous.boardPath.slice(path.length) : DEFAULT_BOARD;
      changed = true;
    }
    if (!changed) return;
    await this.saveData(next);
    this.data = next;
    this.index.remove(next.boardPath);
    this.notify();
  }
}
