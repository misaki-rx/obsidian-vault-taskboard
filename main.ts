import { MarkdownView, Notice, Plugin, TFile, TFolder } from "obsidian";
import type { TAbstractFile } from "obsidian";
import { Board } from "./src/board";
import { appendTask, DEFAULT_INBOX, taskTitle, type CreatedTask, type TaskDraft } from "./src/new-task";
import {
  categories, editTaskLines, hasBoardBlock, stateKey, taskStatus,
  type Category, type LineEdit, type Status, type Task, type TaskState,
} from "./src/model";
import { TaskIndex } from "./src/task-index";

const DEFAULT_BOARD = "Progress Check.md";
const BOARD_BLOCK = "```progress-check\n```\n";

interface BoardData {
  boardPath: string;
  boardWidth?: number;
  tasks: Record<string, TaskState>;
}

type Change = { status: Status } | { category: Category | null };

function restoreData(raw: unknown): BoardData {
  const data = raw as Partial<BoardData> | null;
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
    if (value?.category && categories.includes(value.category)) state.category = value.category;
    if (state.progress || state.category) tasks[stateKey(pair[0], pair[1])] = state;
  }
  const boardWidth = typeof data?.boardWidth === "number" &&
    Number.isFinite(data.boardWidth) && data.boardWidth > 0 ? data.boardWidth : undefined;
  return { boardPath: data?.boardPath || DEFAULT_BOARD, boardWidth, tasks };
}

export default class ProgressChecker extends Plugin {
  private data: BoardData = { boardPath: DEFAULT_BOARD, tasks: {} };
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
        subscribe: listener => {
          this.listeners.add(listener);
          return () => this.listeners.delete(listener);
        },
        move: (tasks, status) => this.change(tasks, { status }),
        categorize: (task, category) => this.change([task], { category }),
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

  private isTaskDestination(path: string, boardPath: string): boolean {
    return path !== boardPath && path !== this.data.boardPath;
  }

  private async createTask(draft: TaskDraft, boardPath: string): Promise<CreatedTask> {
    const title = taskTitle(draft.title);
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
    const next = draft.category ? {
      ...this.data,
      tasks: { ...this.data.tasks, [stateKey(path, blockId)]: { category: draft.category } },
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
    return { path, blockId, category: draft.category };
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

  private async changeNote(path: string, tasks: Task[], change: Change): Promise<void> {
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
    const next: BoardData = { ...previous, tasks: { ...previous.tasks } };
    const edits: LineEdit[] = [];
    let stateChanged = false;
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
      } else {
        if (old?.category === (change.category ?? undefined)) continue;
        if (change.category) state.category = change.category;
        else delete state.category;
      }

      if (task.blockId && (counts.get(task.blockId) ?? 0) > 1) {
        throw new Error("Multiple source tasks have the same block ID.");
      }
      const needsId = !task.blockId && (state.progress || state.category);
      const newBlockId = needsId ? this.makeBlockId(note.source) : undefined;
      const blockId = task.blockId ?? newBlockId;
      if (blockId && (state.progress !== old?.progress || state.category !== old?.category)) {
        const key = stateKey(path, blockId);
        if (state.progress || state.category) next.tasks[key] = state;
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
    do {
      const bytes = crypto.getRandomValues(new Uint8Array(8));
      id = "pc-" + Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    } while (source.includes(`^${id}`));
    return id;
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
