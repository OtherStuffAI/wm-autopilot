function createToolbarButton(label, command, options = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "wm-tiptap-toolbar__button";
  button.textContent = options.text || label;
  button.title = label;
  button.setAttribute("aria-label", label);
  if (options.testId) button.dataset.testid = options.testId;
  button.addEventListener("click", () => command());
  return button;
}

function syncToggle(button, active) {
  button.classList.toggle("is-active", Boolean(active));
  button.setAttribute("aria-pressed", active ? "true" : "false");
}

export function createTiptapToolbar({
  editor,
  mode,
  dirty,
  saving,
  onSave,
  onToggleMode,
}) {
  const toolbar = document.createElement("div");
  toolbar.className = "wm-tiptap-toolbar";
  toolbar.dataset.testid = "tiptap-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Markdown editor toolbar");

  if (mode === "rich" && editor) {
    const buttons = [
      createToolbarButton("Bold", () => editor.chain().focus().toggleBold().run(), { text: "B" }),
      createToolbarButton("Italic", () => editor.chain().focus().toggleItalic().run(), { text: "I" }),
      createToolbarButton("Inline code", () => editor.chain().focus().toggleCode().run(), { text: "</>" }),
      createToolbarButton("Heading", () => editor.chain().focus().toggleHeading({ level: 2 }).run(), { text: "H2" }),
      createToolbarButton("Bullet list", () => editor.chain().focus().toggleBulletList().run(), { text: "UL" }),
      createToolbarButton("Ordered list", () => editor.chain().focus().toggleOrderedList().run(), { text: "OL" }),
      createToolbarButton("Task list", () => editor.chain().focus().toggleTaskList().run(), { text: "[ ]" }),
      createToolbarButton("Blockquote", () => editor.chain().focus().toggleBlockquote().run(), { text: ">" }),
      createToolbarButton("Code block", () => editor.chain().focus().toggleCodeBlock().run(), { text: "{}" }),
      createToolbarButton("Undo", () => editor.chain().focus().undo().run(), { text: "Undo" }),
      createToolbarButton("Redo", () => editor.chain().focus().redo().run(), { text: "Redo" }),
    ];

    const linkButton = createToolbarButton("Add or edit link", () => {
      const previousUrl = editor.getAttributes("link").href || "";
      const url = window.prompt("Link URL", previousUrl);
      if (url === null) return;
      if (!url.trim()) {
        editor.chain().focus().extendMarkRange("link").unsetLink().run();
        return;
      }
      editor.chain().focus().extendMarkRange("link").setLink({ href: url.trim() }).run();
    }, { text: "Link" });
    buttons.push(linkButton);

    for (const button of buttons) toolbar.append(button);

    const refreshActiveState = () => {
      syncToggle(buttons[0], editor.isActive("bold"));
      syncToggle(buttons[1], editor.isActive("italic"));
      syncToggle(buttons[2], editor.isActive("code"));
      syncToggle(buttons[3], editor.isActive("heading", { level: 2 }));
      syncToggle(buttons[4], editor.isActive("bulletList"));
      syncToggle(buttons[5], editor.isActive("orderedList"));
      syncToggle(buttons[6], editor.isActive("taskList"));
      syncToggle(buttons[7], editor.isActive("blockquote"));
      syncToggle(buttons[8], editor.isActive("codeBlock"));
      syncToggle(linkButton, editor.isActive("link"));
    };
    editor.on("selectionUpdate", refreshActiveState);
    editor.on("transaction", refreshActiveState);
    requestAnimationFrame(refreshActiveState);
  }

  const spacer = document.createElement("span");
  spacer.className = "wm-tiptap-toolbar__spacer";
  toolbar.append(spacer);

  const modeButton = createToolbarButton(
    mode === "source" ? "Switch to rich editor" : "Switch to Markdown source",
    onToggleMode,
    {
      text: mode === "source" ? "Rich" : "Source",
      testId: "tiptap-mode-toggle",
    },
  );
  toolbar.append(modeButton);

  const saveButton = createToolbarButton("Save Markdown file", onSave, {
    text: saving ? "Saving..." : dirty ? "Save" : "Saved",
    testId: "tiptap-save-button",
  });
  saveButton.disabled = saving || !dirty;
  toolbar.append(saveButton);

  return toolbar;
}
