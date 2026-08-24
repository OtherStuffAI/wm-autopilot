import type { ArchivedMessage, ArchivedSession } from "../storage/session-archive-store";
import { normaliseSessionTags } from "./session-metadata";

const KEYWORD_TAGS: Array<[RegExp, string]> = [
  [/\bwingman(?:-?be-?free)?\b/i, "wingman"],
  [/\bflight\s*deck\b|\bwingman-fd\b/i, "flight-deck"],
  [/\btower\b|\bwingman-tower\b/i, "tower"],
  [/\byoke\b|\bwingman-yoke\b/i, "yoke"],
  [/\bautopilot\b|\bwingmen\b/i, "autopilot"],
  [/\bpipeline|flow\b/i, "pipelines"],
  [/\bscheduler|cron|trigger\b/i, "scheduler"],
  [/\bsession|archive|restore|restart\b/i, "sessions"],
  [/\bnip-?98\b/i, "nip98"],
  [/\bnostr\b/i, "nostr"],
  [/\bsignal\b/i, "signal"],
  [/\bwapp|wingman app\b/i, "wapps"],
  [/\bdeploy|caprover|pm2\b/i, "deploy"],
  [/\bgithub|gitea|git\b/i, "git"],
  [/\btest|spec|ci\b/i, "testing"],
  [/\bui|frontend|css|vite\b/i, "ui"],
  [/\bapi|route|endpoint\b/i, "api"],
  [/\bdatabase|sqlite|postgres|kuzu|schema\b/i, "database"],
  [/\bbilling|credits|subscription\b/i, "billing"],
  [/\bauth|delegation|access|permission\b/i, "auth"],
  [/\bmemory|graph\b/i, "memory"],
  [/\bvoice|audio|transcrib/i, "audio"],
  [/\bstorage|upload|attachment\b/i, "storage"],
  [/\btask|board|comment\b/i, "tasks"],
  [/\bchat|thread|message\b/i, "chat"],
];

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "have",
  "into",
  "using",
  "about",
  "session",
  "sessions",
  "wingman",
  "please",
  "need",
  "can",
  "you",
]);

const addTag = (tags: string[], value: unknown): void => {
  const [tag] = normaliseSessionTags(value) ?? [];
  if (tag && !tags.includes(tag)) {
    tags.push(tag);
  }
};

const basenameTag = (value: string | null | undefined): string | null => {
  const parts = String(value ?? "").split(/[\\/]/).filter(Boolean);
  const last = parts.at(-1) ?? "";
  return normaliseSessionTags(last)?.[0] ?? null;
};

const mostRelevantWords = (text: string): string[] => {
  const counts = new Map<string, number>();
  for (const raw of text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []) {
    const word = raw.replace(/^-|-$/g, "");
    if (STOPWORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([word]) => word);
};

export function generateArchivedSessionTags(
  session: ArchivedSession,
  messages: ArchivedMessage[] = [],
): string[] {
  const tags: string[] = [];
  addTag(tags, session.agent);
  addTag(tags, session.metadata.role);
  addTag(tags, session.metadata.project);
  addTag(tags, session.metadata.bindingType);
  addTag(tags, session.origin?.type);
  addTag(tags, basenameTag(session.workingDirectory));

  const sampledMessages = messages
    .slice(0, 4)
    .concat(messages.slice(-4))
    .map((message) => message.content)
    .join("\n");
  const text = [
    session.name,
    session.agent,
    session.workingDirectory,
    session.metadata.goal,
    session.metadata.project,
    session.origin?.label,
    sampledMessages,
  ].filter(Boolean).join("\n");

  for (const [pattern, tag] of KEYWORD_TAGS) {
    if (pattern.test(text)) addTag(tags, tag);
  }

  for (const word of mostRelevantWords(text)) {
    addTag(tags, word);
  }

  return tags.slice(0, 12);
}

export function mergeSessionTags(
  existing: unknown,
  generated: string[],
): string[] {
  return normaliseSessionTags([...(normaliseSessionTags(existing) ?? []), ...generated]) ?? [];
}
