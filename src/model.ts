import type { CachedMetadata } from "obsidian";

export const statuses = ["todo", "progress", "done"] as const;
export type Status = typeof statuses[number];

export const statusLabels: Record<Status, string> = {
  todo: "To Do",
  progress: "In Progress",
  done: "Done",
};

export const builtInCategories = ["Read", "Implementation", "Write"] as const;
export type Category = string;

export function labelKey(name: string): string {
  return name.trim().normalize("NFC").toLowerCase();
}

export function findCategory(names: readonly Category[], name: string): Category | undefined {
  const key = labelKey(name);
  return names.find(category => labelKey(category) === key);
}

export function categoryName(input: string): Category {
  const name = input.trim().normalize("NFC");
  if (!name) throw new Error("Enter a category name.");
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error("Use a single line for the category name.");
  if (["uncategorized", "+ category", "all categories"].includes(labelKey(name))) {
    throw new Error("That label is reserved by the category menu.");
  }
  return name;
}

export interface TaskState {
  progress?: true;
  category?: Category;
  projectId?: string;
}

export interface Project {
  id: string;
  name: string;
}

export type ProjectChoice = string | { name: string } | null;

export function projectName(input: string): string {
  const name = input.trim().normalize("NFC");
  if (!name) throw new Error("Enter a project name.");
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error("Use a single line for the project name.");
  if (["no project", "+ project", "all projects"].includes(labelKey(name))) {
    throw new Error("That label is reserved by the project menu.");
  }
  return name;
}

export interface Task {
  key: string;
  path: string;
  line: number;
  title: string;
  details: string;
  marker: string;
  blockId?: string;
  anchorLine?: number;
}

export interface NoteTasks {
  source: string;
  metadata: CachedMetadata;
  tasks: Task[];
}

export function stateKey(path: string, blockId: string): string {
  return JSON.stringify([path, blockId]);
}

export function taskStatus(task: Task, state?: TaskState): Status {
  if (task.marker !== " ") return "done";
  return state?.progress ? "progress" : "todo";
}

const boardBlockPattern = /^([ 	]*)(`{3,}|~{3,})progress-check[ 	]*$/m;

export function hasBoardBlock(source: string): boolean {
  return boardBlockPattern.test(source);
}

const taskPattern = /^([\uFEFF\t ]*(?:>[\t ]*)*(?:[-+*]|\d{1,9}[.)])[\t ]+\[)([^\]\r\n])(\](?=[\t ]|$))(.*)$/;
const blockIdPattern = /(?:^|[\t ]+)\^([A-Za-z0-9-]+)[\t ]*$/;
const fallbackIdPattern = /[\t ]*<!-- progress-check:(pc-[a-f0-9]{16}) -->[\t ]*$/;
const generatedIdPattern = /^pc-[a-f0-9]{16}$/;
const newParagraphPattern = /^(?:`{3,}|~{3,}|#{1,6}(?:\s|$)|>|(?:[-*_][\t ]*){3,}$)/;

function parseTaskLine(line: string) {
  const match = taskPattern.exec(line);
  if (!match) return;
  const [, prefix, marker, close, body] = match;
  return { prefix, marker, close, body };
}

function stripId(line: string, blockId?: string): string {
  if (!blockId) return line;
  const match = fallbackIdPattern.exec(line) ?? blockIdPattern.exec(line);
  return match?.[1] === blockId ? line.slice(0, match.index) : line;
}

export function collectTasks(path: string, source: string, metadata: CachedMetadata): Task[] {
  const items = metadata.listItems;
  if (!items?.some(item => item.task !== undefined)) return [];

  const lines = source.split(/\r\n|\n|\r/);
  const tasks: Task[] = [];
  for (const [index, item] of items.entries()) {
    if (item.task === undefined) continue;
    const line = item.position.start.line;
    const parsed = parseTaskLine(lines[line] ?? "");
    if (!parsed) continue;

    const nextLine = items[index + 1]?.position.start.line ?? lines.length;
    const end = Math.min(item.position.end.line + 1, nextLine);
    const detailLines = lines.slice(line + 1, Math.min(end, line + 25));
    const quoted = parsed.prefix.includes(">");
    let paragraphEnd = line;
    if (!quoted) {
      for (let cursor = line + 1; cursor < end; cursor += 1) {
        const text = lines[cursor]?.trim();
        if (!text || newParagraphPattern.test(text)) break;
        paragraphEnd = cursor;
      }
    }
    const anchor = lines[paragraphEnd] ?? "";
    const candidate = blockIdPattern.exec(paragraphEnd === line ? parsed.body : anchor)?.[1];
    const generatedId = candidate && generatedIdPattern.test(candidate) ? candidate : undefined;
    const blockId = item.id ?? fallbackIdPattern.exec(parsed.body)?.[1] ?? generatedId;
    // Quoted list items lack individual Obsidian block anchors.
    const anchorLine = quoted || /[\t ]$/.test(anchor) || candidate !== undefined ? undefined : paragraphEnd;
    const details = detailLines
      .map(detail => {
        const text = detail.replace(/^[\t ]*(?:>[\t ]*)+/, "");
        return stripId(text, blockId).trim();
      })
      .join("\n")
      .trim();

    tasks.push({
      key: JSON.stringify([path, line]),
      path,
      line,
      title: stripId(parsed.body, blockId).trim(),
      details,
      marker: parsed.marker,
      blockId,
      anchorLine,
    });
  }
  return tasks;
}

export interface LineEdit {
  task: Task;
  marker: string;
  newBlockId?: string;
}

export function editTaskLines(source: string, edits: LineEdit[]): string {
  const lines = source.split(/(\r\n|\n|\r)/);
  for (const { task, marker, newBlockId } of edits) {
    const index = task.line * 2;
    const parsed = parseTaskLine(lines[index] ?? "");
    if (!parsed || parsed.marker !== task.marker || stripId(parsed.body, task.blockId).trim() !== task.title) {
      throw new Error("The source task changed.");
    }
    lines[index] = `${parsed.prefix}${marker}${parsed.close}${parsed.body}`;
    if (newBlockId) {
      const anchorIndex = (task.anchorLine ?? task.line) * 2;
      const content = lines[anchorIndex];
      const text = content.trimEnd();
      const id = task.anchorLine === undefined
        ? `<!-- progress-check:${newBlockId} -->`
        : `^${newBlockId}`;
      lines[anchorIndex] = `${text} ${id}${content.slice(text.length)}`;
    }
  }
  return lines.join("");
}
