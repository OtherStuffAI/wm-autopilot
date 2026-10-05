import type { JsonObject } from "./pipeline-store";

function escaped(value: string): string {
  // Prevent canonical mention syntax, links, HTML and formatting from untrusted records.
  return value.replace(/[&<>]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]!)
    .replace(/[\\`*_{}\[\]()#!|~@]/g, char => `\\${char}`);
}

export function formatBirdRetrieval(input: JsonObject): JsonObject {
  const state = input.state as JsonObject | undefined;
  if (!state || !["complete", "partial", "needs_clarification", "unsupported", "blocked"].includes(String(state.verdict))) throw new Error("Missing terminal Bird result");
  if (!Array.isArray(state.tweets)) throw new Error("Missing Bird tweet records");
  let message: string;
  if (state.interpretation && ["needs_clarification", "unsupported"].includes(String(state.verdict))) {
    message = String(state.reason);
  } else if (state.verdict === "needs_clarification") {
    message = state.reason === "Would you like your Following feed or your For You feed?" ? String(state.reason)
      : "Please specify a source (Following, For You, mentions, @handle, or a quoted search query) and a count from 1 to 100.";
  } else if (state.verdict === "blocked") {
    message = state.reason === "cli_authentication" ? "Bird could not retrieve tweets because its account authentication needs attention."
      : "Bird could not safely complete this retrieval. Please check its run details or clarify the source and request.";
  } else {
    const source = ({ following: "Following", for_you: "For You", user_tweets: "user tweets", search: "search", mentions: "mentions" } as Record<string, string>)[String(state.source)];
    if (!source) throw new Error("Invalid Bird result source");
    const records = state.tweets.map(value => {
      const tweet = value as JsonObject;
      if (!tweet || typeof tweet.id !== "string" || !/^\d+$/.test(tweet.id) || typeof tweet.text !== "string") throw new Error("Invalid Bird tweet record");
      const author = tweet.author as JsonObject | undefined;
      const handle = typeof author?.username === "string" && /^[A-Za-z0-9_]{1,15}$/.test(author.username) ? author.username : null;
      const name = typeof author?.name === "string" ? escaped(author.name) : "";
      const label = handle ? `${name ? `${name} ` : ""}\\@${handle}` : "Author unavailable";
      const url = handle ? `https://x.com/${handle}/status/${tweet.id}` : `https://x.com/i/status/${tweet.id}`;
      // Quoted exact text is data. Only the validated ID/handle constructs a link.
      return `**${label}** · [View tweet](${url})\n${escaped(tweet.text).split("\n").map(line => `> ${line}`).join("\n")}`;
    });
    message = state.verdict === "partial" ? `Retrieved ${records.length} of ${state.count} requested tweets from ${source}; Bird stopped before the full count.`
      : `Retrieved ${records.length} tweets from ${source}.`;
    if (records.length) message += `\n\n${records.join("\n\n")}`;
  }
  if (Array.isArray(state.disclosures) && state.disclosures.length) message = `${state.disclosures.map(String).join("\n")}\n\n${message}`;
  return { message, verdict: state.verdict, resultCount: state.tweets.length };
}
