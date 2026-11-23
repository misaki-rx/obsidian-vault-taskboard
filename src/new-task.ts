import type { TFile } from "obsidian";
import type { Category } from "./model";

export const DEFAULT_INBOX = "Progress Inbox.md";

export interface TaskDraft {
  title: string;
  category: Category | null;
  destination: TFile | null;
}

export interface CreatedTask {
  path: string;
  blockId: string;
  category: Category | null;
}

export function taskTitle(input: string): string {
  const title = input.trim();
  if (!title) throw new Error("Enter a task title.");
  if (/[\u0000-\u001f\u007f]/.test(title)) {
    throw new Error("Use a single line for the task title.");
  }
  if (title.includes("%%") || title.includes("<!--")) {
    throw new Error("Task titles cannot contain Markdown comment markers.");
  }
  return title;
}

function checkAppendLocation(lines: string[]): void {
  let start = 0;
  if (/^\uFEFF?---[\t ]*$/.test(lines[0])) {
    const end = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)[\t ]*$/.test(line));
    if (end < 0) throw new Error("Close the note's frontmatter before adding a task.");
    start = end + 1;
  }

  let fence = "";
  let comment = "";
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) {
        fence = "";
      }
      continue;
    }
    if (!comment && match && (match[1][0] === "~" || !match[2].includes("`"))) {
      fence = match[1];
      continue;
    }
    if (comment) {
      if (line.includes(comment)) comment = "";
    } else {
      const opening = /^ {0,3}(<!--|%%)/.exec(line);
      if (opening) {
        const terminator = opening[1] === "<!--" ? "-->" : "%%";
        if (!line.slice(opening[0].length).includes(terminator)) comment = terminator;
      }
    }
  }

  if (fence || comment) {
    throw new Error("Close the open code block or comment in the destination note before adding a task.");
  }
}

export function appendTask(source: string, title: string, blockId: string): string {
  const lines = source.split(/\r\n|\n|\r/);
  checkAppendLocation(lines);
  const newline = source.match(/\r\n|\n|\r/)?.[0] ?? "\n";
  const endsWithNewline = /[\r\n]$/.test(source);
  const hasBlankLine = endsWithNewline && lines[lines.length - 2].trim() === "";
  const separator = !source || hasBlankLine ? "" : endsWithNewline ? newline : newline + newline;
  return `${source}${separator}- [ ] ${title} ^${blockId}${newline}`;
}
