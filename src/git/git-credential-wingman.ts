#!/usr/bin/env bun

import { runWingmanCredentialHelper } from "./wingman-credential-helper";

const exitCode = await runWingmanCredentialHelper(Bun.argv[2], {
  async readStdin() {
    return await new Response(Bun.stdin.stream()).text();
  },
  writeStdout(value) {
    process.stdout.write(value);
  },
  writeStderr(value) {
    process.stderr.write(value);
  },
});

process.exit(exitCode);
