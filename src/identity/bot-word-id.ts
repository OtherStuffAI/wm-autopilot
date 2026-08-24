/**
 * Bot Word-ID Generator
 *
 * Generates deterministic three-word identifiers for bot keys.
 * Same pubkey always produces the same word-id.
 * Format: "adjective-noun-noun" e.g. "bold-oak-kite"
 */

import { createHash } from "node:crypto";

const ADJECTIVES = [
  "able", "bold", "calm", "dark", "deep",
  "fair", "fast", "free", "full", "good",
  "keen", "kind", "lean", "live", "long",
  "mild", "near", "next", "open", "pale",
  "pure", "rare", "real", "rich", "safe",
  "slim", "soft", "sure", "tall", "thin",
  "true", "warm", "wide", "wild", "wise",
  "blue", "cool", "gray", "red", "young",
  "raw", "late", "left", "zero", "keen",
  "iron", "gold", "jade", "onyx", "ruby",
  "opal", "rust", "silk", "teal", "void",
  "grim", "hale", "just", "loud", "meek",
  "neat", "deft", "wry", "apt", "dry",
  "hot", "icy", "odd", "shy", "sly",
] as const;

const NOUNS = [
  "arch", "axle", "barn", "bell", "bird",
  "boat", "bolt", "book", "cave", "chip",
  "clay", "coin", "cord", "crow", "cube",
  "dart", "disk", "dock", "dome", "door",
  "drum", "duck", "fern", "fish", "flag",
  "fork", "frog", "gate", "gear", "goat",
  "grid", "harp", "hawk", "helm", "hill",
  "hook", "horn", "kite", "knob", "lamp",
  "leaf", "link", "lock", "loom", "mill",
  "mint", "moon", "moth", "nest", "node",
  "palm", "peak", "pike", "pine", "pool",
  "rack", "rail", "reed", "ring", "rock",
  "rope", "rose", "sail", "seal", "seed",
  "shed", "ship", "sign", "slab", "snow",
  "star", "stem", "swan", "tank", "tent",
  "tile", "toad", "tree", "tube", "twig",
  "vase", "vine", "wall", "wasp", "wave",
  "well", "wick", "wing", "wolf", "wood",
  "wren", "ash", "bay", "dew", "elm",
  "fog", "gem", "hay", "ice", "ink",
  "ivy", "jet", "key", "oak", "orb",
  "owl", "rye", "sky", "sun", "tea",
  "tin", "wax", "web", "yew", "zen",
] as const;

const pickWord = (hash: Buffer, offset: number, list: readonly string[]): string => {
  const value = ((hash[offset] ?? 0) << 8) | (hash[offset + 1] ?? 0);
  return list[value % list.length]!;
};

/**
 * Generate a deterministic three-word identifier for a bot.
 * Same pubkey always produces the same word-id.
 *
 * @param pubkeyHex - Bot's public key (64-char hex)
 * @returns Word-id like "bold-oak-kite"
 */
export function generateBotWordId(pubkeyHex: string): string {
  const hash = createHash("sha256").update(pubkeyHex).digest();
  const adj = pickWord(hash, 0, ADJECTIVES);
  const noun1 = pickWord(hash, 2, NOUNS);
  const noun2 = pickWord(hash, 4, NOUNS);
  return `${adj}-${noun1}-${noun2}`;
}
