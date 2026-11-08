export interface CommentPage<T> { comments: T[]; next_cursor: string | null; has_more?: boolean; }

export function validateCommentPage(page: unknown): asserts page is CommentPage<{ id: string }> {
  const value = page as Partial<CommentPage<{ id: string }>> | null;
  if (!value || !Array.isArray(value.comments)) throw new Error("Comment page is missing comments.");
  if (value.next_cursor !== null && (typeof value.next_cursor !== "string" || !value.next_cursor.trim())) {
    throw new Error("Comment page requires an explicit next_cursor string or terminal null.");
  }
  if (value.has_more !== undefined && (typeof value.has_more !== "boolean" || value.has_more !== Boolean(value.next_cursor))) {
    throw new Error("Comment page has_more disagrees with next_cursor.");
  }
}

/** A single page is explicitly partial; --all and exports must prove progress on every page. */
export async function readCommentPages<T extends { id: string }>(
  fetchPage: (cursor?: string | null) => Promise<CommentPage<T>>,
  input: { cursor?: string | null; all?: boolean } = {},
) {
  let cursor = input.cursor;
  const cursors = new Set<string>();
  const ids = new Set<string>();
  const comments: T[] = [];
  let first: CommentPage<T> | undefined;
  for (;;) {
    if (cursor) {
      if (cursors.has(cursor)) throw new Error("Comment pagination repeated cursor; refusing incomplete retrieval.");
      cursors.add(cursor);
    }
    const page = await fetchPage(cursor);
    first ??= page;
    validateCommentPage(page);
    for (const comment of page.comments) {
      if (!comment.id || ids.has(comment.id)) throw new Error("Comment pagination repeated a row; refusing incomplete retrieval.");
      ids.add(comment.id);
      comments.push(comment);
    }
    const partial = Boolean(page.next_cursor);
    if (!input.all || !partial) return { ...first, comments, next_cursor: page.next_cursor, has_more: partial, partial: partial || Boolean(input.cursor), complete: !partial && !input.cursor };
    if (!page.comments.length || page.next_cursor === cursor) throw new Error("Comment pagination made no progress; refusing incomplete retrieval.");
    cursor = page.next_cursor;
  }
}
