import type { App, CachedMetadata, TFile } from "obsidian";
import { collectTasks, type NoteTasks, type Task } from "./model";

const READ_BATCH_SIZE = 20;

export class TaskIndex {
  readonly notes = new Map<string, NoteTasks>();
  loading = true;
  failedReads = 0;
  started = false;
  private stopped = false;
  private readonly pending = new Map<string, symbol>();

  constructor(
    private readonly app: App,
    private readonly excluded: (path: string) => boolean,
    private readonly notify: () => void,
  ) {}

  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    await this.scan(true);
  }

  async refresh(): Promise<void> {
    if (!this.started || this.loading || this.stopped) return;
    this.loading = true;
    this.failedReads = 0;
    this.notify();
    await this.scan(false);
  }

  private async scan(skipIndexed: boolean): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    for (let offset = 0; offset < files.length && !this.stopped; offset += READ_BATCH_SIZE) {
      const batch = files.slice(offset, offset + READ_BATCH_SIZE)
        .filter(file => !skipIndexed || !this.notes.has(file.path));
      await Promise.all(batch.map(file => this.read(file)));
      await new Promise<void>(resolve => window.setTimeout(resolve, 0));
    }
    this.loading = false;
    this.notify();
  }

  all(): Task[] {
    const tasks: Task[] = [];
    for (const note of this.notes.values()) {
      for (const task of note.tasks) tasks.push(task);
    }
    return tasks;
  }

  accept(file: TFile, source: string, metadata: CachedMetadata): void {
    const path = file.path;
    this.pending.delete(path);
    if (this.stopped || this.excluded(path)) {
      this.remove(path);
      return;
    }
    const last = this.notes.get(path);
    if (last?.source === source && last.metadata === metadata) return;

    const tasks = collectTasks(path, source, metadata);
    if (tasks.length) {
      this.notes.set(path, { source, metadata, tasks });
      this.notify();
    } else {
      this.remove(path);
    }
  }

  async read(file: TFile): Promise<void> {
    const path = file.path;
    if (this.stopped || this.excluded(path) || file.extension !== "md") return;
    if (this.app.vault.getFileByPath(path) !== file) return;
    const metadata = this.app.metadataCache.getFileCache(file);
    if (!metadata) return;
    if (!metadata.listItems?.some(item => item.task !== undefined)) {
      this.remove(path);
      return;
    }

    const token = Symbol();
    const modified = file.stat.mtime;
    this.pending.set(path, token);
    try {
      const source = await this.app.vault.cachedRead(file);
      if (
        this.pending.get(path) === token &&
        file.path === path &&
        file.stat.mtime === modified &&
        this.app.metadataCache.getFileCache(file) === metadata
      ) {
        this.accept(file, source, metadata);
      }
    } catch (error) {
      if (this.pending.get(path) === token) {
        this.failedReads += 1;
        this.notify();
        console.warn("Progress Checker could not read a note", error);
      }
    } finally {
      if (this.pending.get(path) === token) this.pending.delete(path);
    }
  }

  remove(path: string): void {
    this.pending.delete(path);
    if (this.notes.delete(path)) this.notify();
  }

  move(oldPath: string, file: TFile): void {
    const note = this.notes.get(oldPath);
    this.remove(oldPath);
    if (note) this.accept(file, note.source, note.metadata);
    void this.read(file);
  }

  stop(): void {
    this.stopped = true;
    this.pending.clear();
    this.notes.clear();
  }
}
