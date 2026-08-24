import { describe, expect, test } from "bun:test";

import { parseDotenvText } from "./dotenv-file";

describe("dotenv file helpers", () => {
  test("parses common .env syntax and reports ignored lines", () => {
    const result = parseDotenvText(`
# comment
WAPP_NSEC=nsec1secret
QUOTED="hello world"
SINGLE='literal # value'
export TOWER_URL=https://tower.example # inline comment
APP_ID=reserved
bad line
`);

    expect(result.env).toEqual({
      QUOTED: "hello world",
      SINGLE: "literal # value",
      TOWER_URL: "https://tower.example",
      WAPP_NSEC: "nsec1secret",
    });
    expect(result.warnings).toContain("Line 7 ignored: Environment variable key is managed by Wingman: APP_ID");
    expect(result.warnings).toContain("Line 8 ignored: expected KEY=value");
  });
});
