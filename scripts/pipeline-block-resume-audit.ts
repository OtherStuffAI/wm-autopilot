import { Database } from "bun:sqlite";
import { auditLegacyBlockResumes } from "../src/pipelines/pipeline-block-resume-audit";

const path = process.argv[2];
if (!path) throw new Error("Usage: bun scripts/pipeline-block-resume-audit.ts <pipeline-database>");
const db = new Database(path, { readonly: true });
try {
  process.stdout.write(JSON.stringify({ legacyPendingRuns: auditLegacyBlockResumes(db) }, null, 2) + "\n");
} finally { db.close(); }
