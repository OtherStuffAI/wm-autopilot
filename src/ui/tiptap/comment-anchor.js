function findBlockHint(markdown, index) {
  if (index < 0) return "";
  const before = String(markdown ?? "").slice(0, index);
  const headings = before.match(/^#{1,6}\s+.+$/gm);
  return headings?.[headings.length - 1] ?? "";
}

export function buildCommentAnchor({ markdown, mode, editor, sourceEditor } = {}) {
  const body = String(markdown ?? "");
  let selectedText = "";
  if (mode === "source" && sourceEditor) {
    selectedText = sourceEditor.value.slice(sourceEditor.selectionStart, sourceEditor.selectionEnd).trim();
  } else if (editor) {
    const { from, to } = editor.state.selection;
    selectedText = from === to ? "" : editor.state.doc.textBetween(from, to, " ").trim();
  }
  if (!selectedText) return null;
  const index = body.indexOf(selectedText);
  return {
    type: "quote",
    text: selectedText,
    prefix: index > 0 ? body.slice(Math.max(0, index - 80), index).trim() : "",
    suffix: index >= 0 ? body.slice(index + selectedText.length, index + selectedText.length + 80).trim() : "",
    blockHint: findBlockHint(body, index),
  };
}
