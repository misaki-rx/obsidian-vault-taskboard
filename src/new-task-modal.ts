import { FuzzySuggestModal, Modal, Setting, type App, type TFile } from "obsidian";
import { categories, type Category } from "./model";
import { DEFAULT_INBOX, type TaskDraft } from "./new-task";

class DestinationPicker extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private readonly files: TFile[],
    private readonly choose: (file: TFile) => void,
  ) {
    super(app);
    this.setPlaceholder("Search Markdown notes by name or path…");
  }

  getItems(): TFile[] {
    return this.files;
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.choose(file);
  }
}

export class NewTaskModal extends Modal {
  constructor(
    app: App,
    private readonly initialCategory: Category | null,
    private readonly destinations: () => TFile[],
    private readonly submitTask: (draft: TaskDraft) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("New task");
    const form = this.contentEl.createEl("form", { cls: "pc-new-task-form" });
    const titleRow = new Setting(form).setName("Task title");
    const title = titleRow.controlEl.createEl("input", {
      attr: { type: "text", "aria-label": "Task title", required: "required" },
    });

    let category = this.initialCategory;
    new Setting(form).setName("Category").addDropdown(dropdown => {
      dropdown.addOption("", "Uncategorized");
      for (const name of categories) dropdown.addOption(name, name);
      dropdown.setValue(category ?? "");
      dropdown.selectEl.setAttribute("aria-label", "Category");
      dropdown.onChange(value => { category = categories.find(item => item === value) ?? null; });
    });

    let destination: TFile | null = null;
    const destinationRow = new Setting(form).setName("Save to").setDesc(DEFAULT_INBOX);
    const choose = destinationRow.controlEl.createEl("button", {
      text: "Choose note",
      attr: { type: "button" },
    });
    const reset = destinationRow.controlEl.createEl("button", {
      text: "Use inbox",
      attr: { type: "button" },
    });
    reset.hidden = true;
    const selectDestination = (file: TFile | null) => {
      destination = file;
      destinationRow.setDesc(file?.path ?? DEFAULT_INBOX);
      reset.hidden = !file;
      choose.focus();
    };
    choose.addEventListener("click", () => {
      new DestinationPicker(this.app, this.destinations(), selectDestination).open();
    });
    reset.addEventListener("click", () => selectDestination(null));

    const error = form.createDiv({ cls: "pc-new-task-error", attr: { role: "alert" } });
    const actions = new Setting(form);
    const cancel = actions.controlEl.createEl("button", {
      text: "Cancel",
      attr: { type: "button" },
    });
    cancel.addEventListener("click", () => this.close());
    const submit = actions.controlEl.createEl("button", {
      cls: "mod-cta",
      text: "Create task",
      attr: { type: "submit" },
    });
    const controls = form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
      "input, select, button",
    );
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (submit.disabled) return;
      error.textContent = "";
      try {
        const draft = { title: title.value, category, destination };
        for (const control of controls) control.disabled = true;
        await this.submitTask(draft);
        this.close();
      } catch (failure) {
        error.textContent = failure instanceof Error ? failure.message : "Could not save the task. Try again.";
      } finally {
        for (const control of controls) control.disabled = false;
      }
    });
    title.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
