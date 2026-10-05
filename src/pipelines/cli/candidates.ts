import type { Candidate, CliContract } from "./contract";

const small = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const tens = ["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
export function numericSpan(span: string): number | null {
  if (/^[-+]?\d+(?:\.\d+)?$/.test(span)) return Number(span);
  const words = span.toLowerCase().replace(/-/g, " ").split(/\s+/).filter(word => word !== "and");
  let value = 0;
  for (const word of words) {
    if (small.includes(word)) value += small.indexOf(word);
    else if (tens.includes(word)) value += (tens.indexOf(word) + 2) * 10;
    else if (word === "hundred") value = (value || 1) * 100;
    else if (word === "dozen") value = (value || 1) * 12;
    else if (word === "score") value = (value || 1) * 20;
    else if (word !== "a") return null;
  }
  return words.length ? value : null;
}
export function stripRoutingMentions(request: string): string {
  return request.replace(/@\[[^\]\n]*\]\(mention:(?:agent|person):[^)\n]+\)/g, " ").trim();
}
export function extractCandidates(request: string, contract: CliContract): Record<string, Candidate[]> {
  const queries = [...request.matchAll(/"([^"\n]{1,500})"|“([^”\n]{1,500})”|'([^'\n]{1,500})'/g)].map(m => ({ span: m[0], value: (m[1] ?? m[2] ?? m[3])! }));
  const handles = [...request.matchAll(/(?:@|https?:\/\/(?:www\.)?(?:x|twitter)\.com\/)([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/g)].map(m => ({ span: m[0], value: m[1]! }));
  const text = request.replace(/https?:\/\/\S+|@[A-Za-z0-9_]+|"[^"]*"|“[^”]*”|'[^']*'/g, m => " ".repeat(m.length));
  const numbers = [...text.matchAll(/(?<![A-Za-z0-9_])[-+]?\d+(?:\.\d+)?(?![A-Za-z0-9_])/g)].map(m => ({ span: m[0], value: Number(m[0]) }));
  const wordPattern = new RegExp(`\\b(?:${[...small, ...tens, "hundred"].join("|")})(?:[ -]+(?:${[...small, ...tens, "hundred", "and"].join("|")}))*\\b`, "gi");
  for (const match of text.matchAll(wordPattern)) { const value = numericSpan(match[0]); if (value !== null) numbers.push({ span: match[0], value }); }
  return Object.fromEntries(Object.entries(contract.arguments).map(([name, arg]) => [name, arg.kind === "number" ? numbers : arg.kind === "handle" ? handles : queries]));
}
