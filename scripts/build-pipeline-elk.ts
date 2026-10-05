import ts from "typescript";

// Preserve cooked string values while avoiding literal trailing whitespace in
// Bun's multiline template emission. Tagged templates require raw text and are
// deliberately rejected rather than silently changing their semantics.
function emitWhitespaceSafeLiterals(source: string) {
  const ast = ts.createSourceFile("elk-bundle.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits: Array<{start: number; end: number; text: string}> = [];
  function visit(node: ts.Node) {
    if (ts.isNoSubstitutionTemplateLiteral(node) && /[ \t]+\r?\n/.test(node.getText(ast))) {
      if (ts.isTaggedTemplateExpression(node.parent)) throw new Error("ELK bundle contains a whitespace-sensitive tagged template");
      edits.push({start: node.getStart(ast), end: node.end, text: JSON.stringify(node.text)});
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  for (const edit of edits.sort((a,b) => b.start - a.start))
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return source;
}

// Self-contained ELK browser bundle: no workers or runtime network imports.
const result = await Bun.build({
  entrypoints: ["scripts/pipeline-elk-entry.ts"],
  target: "browser", format: "esm", minify: true,
});
if (!result.success) throw new Error(result.logs.join("\n"));
await Bun.write("src/ui/pipelines/elk-bundle.js", emitWhitespaceSafeLiterals(await result.outputs[0]!.text()));
