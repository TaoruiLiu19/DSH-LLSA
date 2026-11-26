/** Human-editable assets; build-local replaces this module with string constants. */
import { readFileSync } from "node:fs";
const read = (path) =>
  readFileSync(new URL(path, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const readPrompt = (name) => read("./prompts/" + name + ".md").trim().replace(/\r?\n/g, " ");
export const PANEL_HTML = read("./panel/index.html").replace(
  "/* PANEL_STYLES */",
  () => read("./panel/styles.css"),
);
export const PANEL_SCRIPT = [read("./panel/flow-model.js"), read("./panel/flow-view.js"), read("./panel/app.js")].join("\n");
export const MANAGED_CHILD_GUIDANCE = readPrompt("managed-child");
export const TOOL_DESCRIPTIONS = Object.freeze(
  Object.fromEntries(
    [
      "collab_status",
      "collab_delegate",
      "collab_compute",
      "collab_complete_computation",
      "collab_publish",
      "collab_send",
      "collab_history",
      "collab_read_evidence",
      "collab_accept",
      "collab_project_log",
    ].map((name) => [name, readPrompt(name)]),
  ),
);
