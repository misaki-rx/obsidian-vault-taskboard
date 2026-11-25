# Vault Taskboard

Vault Taskboard brings Markdown checkboxes from across your Obsidian vault into one Kanban board with **To Do**, **In Progress**, and **Done** columns. Completing or reopening a task updates the checkbox in its source note.

## Install

Requires Obsidian 1.5.7 or later. From a checkout of this repo, run `npm ci` and `npm run build`. Copy `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/progress-checker/` in your vault, then enable **Progress Checker** under **Settings → Community plugins**.

## Use the board

Run **Progress Checker: Open board** from the command palette. The plugin opens `Progress Check.md` in Reading view and creates it on first use.

- Drag a card by its handle or click the handle to choose a column. To start several tasks at once, select them in **To Do** and click **Move … to In Progress**.
- Assign or create categories from a card, then filter the board by category. Click the note name on a card to jump to the source task.
- Use a card's folder menu to assign or create a project. **All projects** groups tasks into collapsible panels. Select a project to focus on it, and use the category filter to narrow the results.
- Use **+ New task** to add a Markdown task to an existing note or to `Progress Inbox.md` by default.

To embed the board in another note, add this block and open the note in Reading view.

````markdown
```progress-check
```
````

The plugin stores categories, project assignments, and **In Progress** status in its own data and can add block IDs to source notes to keep track of those tasks.
