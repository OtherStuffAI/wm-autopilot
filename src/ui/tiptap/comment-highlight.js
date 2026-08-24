function findTextInBlock(blockNode, blockPos, needle) {
  let text = "";
  const positions = [];
  blockNode.descendants((node, pos) => {
    if (!node.isText) return;
    const value = node.text || "";
    for (let index = 0; index < value.length; index += 1) {
      text += value[index];
      positions.push(blockPos + pos + index + 1);
    }
  });
  const index = text.indexOf(needle);
  if (index < 0) return null;
  return { from: positions[index], to: positions[index + needle.length - 1] + 1 };
}

export function findCommentAnchorRange(editor, anchor) {
  const needle = String(anchor?.text || "").trim();
  if (!editor || !needle) return null;
  let range = null;
  editor.state.doc.descendants((node, pos) => {
    if (range || !node.isTextblock) return;
    if (!node.textContent.includes(needle)) return;
    range = findTextInBlock(node, pos, needle);
  });
  return range;
}

export function highlightCommentAnchor(editor, thread) {
  const range = findCommentAnchorRange(editor, thread?.anchor);
  if (!range) return false;
  editor.chain().focus().setTextSelection(range).scrollIntoView().run();
  return true;
}

export function markActiveCommentThread(panel, threadId) {
  const previous = panel.querySelector(`[data-testid='tiptap-comment-thread'][data-active='true']`);
  previous?.setAttribute("aria-pressed", "false");
  previous?.setAttribute("data-active", "false");
  const next = Array.from(panel.querySelectorAll("[data-testid='tiptap-comment-thread']"))
    .find((item) => item.dataset.threadId === threadId);
  next?.setAttribute("data-active", "true");
  next?.setAttribute("aria-pressed", "true");
}
