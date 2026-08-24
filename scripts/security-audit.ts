const auditProcess = Bun.spawn(["bun", "audit", "--json"], { stdout: "pipe", stderr: "inherit" });
const report = JSON.parse(await new Response(auditProcess.stdout).text()) as Record<string, Array<{ severity?: string }>>;
await auditProcess.exited;

const counts: Record<string, number> = {};
for (const advisories of Object.values(report)) {
  for (const advisory of advisories) {
    const severity = advisory.severity ?? "unknown";
    counts[severity] = (counts[severity] ?? 0) + 1;
  }
}
console.log(JSON.stringify({ vulnerabilities: counts }));
if ((counts.critical ?? 0) > 0 || (counts.high ?? 0) > 0) {
  console.error("Dependency audit rejected critical/high advisories");
  process.exit(1);
}
