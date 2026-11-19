/** Preserve completed native text. The consuming app owns optional design parsing. */
export function validateInterviewReply(reply: string): string {
  if (typeof reply !== "string" || !reply.trim()) throw Error("Completed interview reply is empty");
  if (Buffer.byteLength(reply, "utf8") > 180000) throw Error("Completed interview reply exceeds size limit");
  return reply;
}
