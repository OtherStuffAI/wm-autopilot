function legacyKey(message) {
  return JSON.stringify([message.role, message.content, message.createdAt]);
}

function add(map, key, value) {
  const bucket = map.get(key) ?? [];
  bucket.push(value);
  map.set(key, bucket);
}

function unmatched(bucket, matchedIds) {
  return bucket?.find((message) => !matchedIds.has(message.id)) ?? null;
}

// Build once per snapshot rather than scanning the full timeline for every row.
export function createReconciliationIndex(existing, incoming) {
  const legacy = new Map();
  const optimistic = new Map();
  const users = new Map();
  let watermark = Number.NEGATIVE_INFINITY;
  for (const message of existing) {
    if (message.pending !== true) add(legacy, legacyKey(message), message);
    if (message.optimistic === true) add(optimistic, message.content, message);
  }
  for (const message of incoming) {
    const time = Date.parse(message.createdAt);
    if (Number.isFinite(time)) watermark = Math.max(watermark, time);
    if (message.role === "user") add(users, message.content, message);
  }
  return {
    legacy: (message, matchedIds) => unmatched(legacy.get(legacyKey(message)), matchedIds),
    optimistic: (content, matchedIds) => unmatched(optimistic.get(content), matchedIds),
    snapshotCovers: (message) => Date.parse(message.createdAt) <= watermark,
    userCovered(message) {
      const equivalent = users.get(message.content)?.some((candidate) => {
        if (candidate.createdAt === message.createdAt) return true;
        return message.pending === true &&
          Math.abs(Date.parse(message.createdAt) - Date.parse(candidate.createdAt)) <= 10_000;
      });
      if (equivalent) return true;
      if (message.pending === true || message.optimistic === true) return false;
      return Date.parse(message.createdAt) <= watermark;
    },
  };
}
