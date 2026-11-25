import type { App } from "obsidian";
import { NameModal } from "./category-ui";
import { labelKey, projectName, type Project, type ProjectChoice } from "./model";

export const ALL_PROJECTS = "*";
export const CREATE_PROJECT = "+";
export const DRAFT_PROJECT = "?";
export const NO_PROJECT = "No project";

export function fillProjects(
  select: HTMLSelectElement,
  projects: readonly Project[],
  mode: "filter" | "assign",
): void {
  const previous = select.selectedIndex < 0 ? undefined : select.value;
  select.replaceChildren();
  if (mode === "filter") select.createEl("option", { value: ALL_PROJECTS, text: "All projects" });
  select.createEl("option", { value: "", text: NO_PROJECT });
  for (const project of projects) select.createEl("option", { value: project.id, text: project.name });
  if (mode === "assign") select.createEl("option", { value: CREATE_PROJECT, text: "+ Project" });
  if (previous !== undefined && Array.from(select.options).some(option => option.value === previous)) {
    select.value = previous;
  } else select.selectedIndex = 0;
}

export function openProjectModal(
  app: App,
  projects: () => readonly Project[],
  submit: (choice: ProjectChoice) => void | Promise<void>,
): void {
  new NameModal(app, "project", () => projects().map(project => project.name), projectName, name => {
    const existing = projects().find(project => labelKey(project.name) === labelKey(name));
    return submit(existing?.id ?? { name });
  }).open();
}
