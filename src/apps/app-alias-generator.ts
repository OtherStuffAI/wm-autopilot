import { createHash } from "node:crypto";

import { normaliseNpub } from "../identity/npub-utils";

/**
 * Word lists for generating memorable three-word aliases.
 * Different from identity-alias to give apps distinct naming feel.
 */
const ADJECTIVES = [
  "able", "blue", "bold", "calm", "cool",
  "dark", "deep", "fair", "fast", "free",
  "full", "good", "gray", "keen", "kind",
  "late", "lean", "left", "live", "long",
  "mild", "near", "next", "open", "pale",
  "pure", "rare", "raw", "real", "red",
  "rich", "safe", "slim", "soft", "sure",
  "tall", "thin", "true", "warm", "wide",
  "wild", "wise", "young", "zero", "zinc",
] as const;

const ELEMENTS = [
  "ash", "bay", "bee", "bow", "cap",
  "cup", "dew", "elm", "fin", "fog",
  "gem", "hay", "ice", "ink", "ivy",
  "jam", "jet", "key", "kit", "lap",
  "log", "map", "mud", "net", "oak",
  "orb", "owl", "pan", "pea", "pin",
  "pod", "rib", "rod", "rye", "sky",
  "sun", "tar", "tea", "tin", "wax",
  "web", "yew", "zen", "zip", "zap",
] as const;

const OBJECTS = [
  "arch", "axle", "band", "barn", "bell",
  "bird", "boat", "bolt", "book", "boot",
  "bowl", "cage", "cart", "cave", "chip",
  "clay", "coin", "cord", "crab", "crow",
  "cube", "dart", "disk", "dock", "dome",
  "door", "drum", "duck", "fern", "fish",
  "flag", "fork", "frog", "gate", "gear",
  "goat", "gong", "grid", "harp", "hawk",
  "helm", "hill", "hook", "horn", "kite",
  "knob", "lamp", "leaf", "link", "lock",
  "loom", "mill", "mint", "moon", "moth",
  "nest", "node", "palm", "peak", "pike",
  "pine", "pool", "pump", "quay", "rack",
  "rail", "ramp", "reed", "ring", "rock",
  "rope", "rose", "sail", "seal", "seed",
  "shed", "ship", "sign", "silo", "slab",
  "snow", "sofa", "star", "stem", "swan",
  "tank", "tent", "tile", "toad", "tomb",
  "tree", "tube", "twig", "vase", "vest",
  "vine", "wall", "wasp", "wave", "well",
  "wick", "wing", "wolf", "wood", "wren",
] as const;

const pickWord = (hash: Buffer, offset: number, list: readonly string[]): string => {
  // Use two bytes for better distribution across larger lists
  const value = hash.readUInt16BE(offset);
  return list[value % list.length] ?? list[0] ?? "app";
};

/**
 * Generate a deterministic three-word alias for an app.
 * Same npub + directoryPath always produces the same alias.
 *
 * @param npub - Owner's npub (required)
 * @param directoryPath - Full path to app root (required)
 * @returns Three-word alias like "bold-gem-boat"
 */
export const generateAppAlias = (
  npub: string | null | undefined,
  directoryPath: string | null | undefined,
): string | null => {
  const normalizedNpub = normaliseNpub(npub);
  if (!normalizedNpub || !directoryPath) {
    return null;
  }

  // Combine npub and directory path for unique hash
  const input = `${normalizedNpub}:${directoryPath}`;
  const hash = createHash("sha256").update(input).digest();

  const adjective = pickWord(hash, 0, ADJECTIVES);
  const element = pickWord(hash, 2, ELEMENTS);
  const object = pickWord(hash, 4, OBJECTS);

  return `${adjective}-${element}-${object}`;
};

/**
 * Validate that a string looks like a valid app alias.
 */
export const isValidAppAlias = (alias: string): boolean => {
  if (!alias || typeof alias !== "string") {
    return false;
  }
  // Must be lowercase, hyphen-separated words
  return /^[a-z]+-[a-z]+-[a-z]+$/.test(alias);
};

export type AppAliasGenerator = typeof generateAppAlias;
