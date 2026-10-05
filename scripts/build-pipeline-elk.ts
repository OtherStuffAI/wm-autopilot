// Self-contained ELK browser bundle: no workers or runtime network imports.
const result = await Bun.build({
  entrypoints: ["scripts/pipeline-elk-entry.ts"],
  target: "browser", format: "esm", minify: true,
});
if (!result.success) throw new Error(result.logs.join("\n"));
await Bun.write("src/ui/pipelines/elk-bundle.js", result.outputs[0]!);
