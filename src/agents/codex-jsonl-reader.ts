import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export async function readCodexJsonlRecords(
  filePath: string,
  visit: (record: Record<string, unknown>) => void,
): Promise<void> {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      const record = parseJsonLine(line);
      if (record) {
        visit(record);
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
