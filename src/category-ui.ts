import { Modal, Setting, type App } from "obsidian";
import { categoryName, findCategory, type Category } from "./model";

export const ALL_CATEGORIES = "\u0000all";
export const CREATE_CATEGORY = "\u0000create";

export function fillCategories(
  select: HTMLSelectElement,
  names: readonly Category[],
  purpose: "filter" | "assign",
): void {
  const value = select.selectedIndex < 0 ? undefined : select.value;
  select.replaceChildren();
  if (purpose === "filter") select.createEl("option", { value: ALL_CATEGORIES, text: "All categories" });
  select.createEl("option", { value: "", text: "Uncategorized" });
  for (const name of names) select.createEl("option", { value: name, text: name });
  if (purpose === "assign") select.createEl("option", { value: CREATE_CATEGORY, text: "+ Category" });
  if (value !== undefined && Array.from(select.options).some(option => option.value === value)) select.value = value;
  else select.selectedIndex = 0;
}

export class CategoryModal extends Modal {
  constructor(
    app: App,
    private readonly categories: () => readonly Category[],
    private readonly submitName: (category: Category, isNew: boolean) => Promise<void> | void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("New category");
    const form = this.contentEl.createEl("form");
    const row = new Setting(form).setName("Category name");
    const name = row.controlEl.createEl("input", {
      attr: { type: "text", "aria-label": "Category name", required: "required" },
    });
    const feedback = form.createDiv({ cls: "pc-category-feedback", attr: { role: "status" } });
    const error = form.createDiv({ cls: "pc-form-error", attr: { role: "alert" } });
    const actions = new Setting(form);
    const cancel = actions.controlEl.createEl("button", { text: "Cancel", attr: { type: "button" } });
    cancel.addEventListener("click", () => this.close());
    const submit = actions.controlEl.createEl("button", {
      cls: "mod-cta",
      text: "Create category",
      attr: { type: "submit" },
    });

    name.addEventListener("input", () => {
      const existing = findCategory(this.categories(), name.value);
      feedback.textContent = existing ? `“${existing}” already exists.` : "";
      submit.textContent = existing ? `Use ${existing}` : "Create category";
      error.textContent = "";
    });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (submit.disabled) return;
      error.textContent = "";
      try {
        const proposed = categoryName(name.value);
        const existing = findCategory(this.categories(), proposed);
        name.disabled = cancel.disabled = submit.disabled = true;
        await this.submitName(existing ?? proposed, !existing);
        this.close();
      } catch (failure) {
        error.textContent = failure instanceof Error ? failure.message : "Could not save the category.";
      } finally {
        name.disabled = cancel.disabled = submit.disabled = false;
      }
    });
    name.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
