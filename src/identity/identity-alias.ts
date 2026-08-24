import { createHash } from "node:crypto";

import { normaliseNpub } from "./npub-utils";

const ADJECTIVES = [
  "ancient",
  "bold",
  "brisk",
  "calm",
  "clever",
  "daring",
  "eager",
  "frosty",
  "gentle",
  "glowing",
  "honest",
  "lively",
  "lucky",
  "mighty",
  "noble",
  "quiet",
  "rapid",
  "shiny",
  "silent",
  "sunny",
  "swift",
  "tidy",
  "urban",
  "vivid",
  "warm",
  "witty",
] as const;

const TONES = [
  "amber",
  "azure",
  "bronze",
  "cobalt",
  "coral",
  "crimson",
  "emerald",
  "golden",
  "indigo",
  "ivory",
  "jade",
  "lavender",
  "maroon",
  "navy",
  "olive",
  "onyx",
  "pearl",
  "ruby",
  "saffron",
  "sienna",
  "silver",
  "teal",
  "topaz",
  "umber",
  "violet",
  "zircon",
  "zinc",
  "zinnia",
  "zither",
] as const;

const NOUNS = [
  "anchorage",
  "arch",
  "bastion",
  "bay",
  "beacon",
  "bridge",
  "cascade",
  "citadel",
  "cliff",
  "compass",
  "cove",
  "crest",
  "delta",
  "dune",
  "ember",
  "enclave",
  "estate",
  "fen",
  "forge",
  "garden",
  "gate",
  "glen",
  "grove",
  "harbor",
  "haven",
  "hearth",
  "hideout",
  "horizon",
  "isle",
  "junction",
  "keep",
  "lagoon",
  "landing",
  "lighthouse",
  "locale",
  "lumen",
  "meadow",
  "mesa",
  "mirage",
  "mosaic",
  "nebula",
  "oasis",
  "orchard",
  "outpost",
  "palisade",
  "paragon",
  "pathway",
  "porter",
  "prairie",
  "quarry",
  "quill",
  "reef",
  "refuge",
  "ridge",
  "river",
  "saga",
  "sentinel",
  "solace",
  "spire",
  "spruce",
  "summit",
  "tapestry",
  "tempest",
  "thicket",
  "torch",
  "tower",
  "vesper",
  "voyage",
  "waypoint",
  "wharf",
  "wisdom",
  "workshop",
] as const;

const pickWord = (hash: Buffer, offset: number, list: readonly string[]): string => {
  const value = hash.readUInt8(offset);
  return list[value % list.length] ?? list[0] ?? "anonymous";
};

export const generateIdentityAlias = (npub: string | null | undefined): string => {
  const normalized = normaliseNpub(npub);
  if (!normalized) {
    return "anonymous";
  }

  const hash = createHash("sha256").update(normalized).digest();
  const adjective = pickWord(hash, 0, ADJECTIVES);
  const tone = pickWord(hash, 1, TONES);
  const noun = pickWord(hash, 2, NOUNS);
  return `${adjective}-${tone}-${noun}`;
};

export type IdentityAliasGenerator = typeof generateIdentityAlias;
