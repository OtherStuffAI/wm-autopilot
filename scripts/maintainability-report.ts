import * as path from 'node:path';
import * as ts from 'typescript';
import { $ } from 'bun';

type Finding = {
  file: string;
  line?: number;
  lines: number;
  name?: string;
};

const sourceExtensions = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const skippedPrefixes = [
  'data/',
  'node_modules/',
  'out/',
  'public/vendor/',
  'scripts/isolated-test/',
  'tmp/',
];

const fileLineLimit = parsePositiveInt(process.env.MAINTAINABILITY_FILE_LINES, 400);
const functionLineLimit = parsePositiveInt(process.env.MAINTAINABILITY_FUNCTION_LINES, 120);
const maxFindings = parsePositiveInt(process.env.MAINTAINABILITY_MAX_FINDINGS, 50);

const trackedFiles = await listTrackedSourceFiles();
const largeFiles: Finding[] = [];
const largeFunctions: Finding[] = [];

for (const file of trackedFiles) {
  const text = await Bun.file(file).text();
  const lines = countLines(text);

  if (lines > fileLineLimit) {
    largeFiles.push({ file, lines });
  }

  largeFunctions.push(...findLargeFunctions(file, text, functionLineLimit));
}

largeFiles.sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));
largeFunctions.sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));

printReport({
  largeFiles,
  largeFunctions,
  scannedFiles: trackedFiles.length,
});

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function listTrackedSourceFiles(): Promise<string[]> {
  const output = await $`git ls-files -z`.quiet().text();
  return output
    .split('\0')
    .filter(Boolean)
    .filter(isSourceFile)
    .sort();
}

function isSourceFile(file: string): boolean {
  if (file.endsWith('.d.ts')) {
    return false;
  }

  if (skippedPrefixes.some((prefix) => file.startsWith(prefix))) {
    return false;
  }

  return sourceExtensions.has(path.extname(file));
}

function countLines(text: string): number {
  if (!text) {
    return 0;
  }

  const lineCount = text.split(/\r\n|\r|\n/).length;
  return text.endsWith('\n') || text.endsWith('\r') ? lineCount - 1 : lineCount;
}

function findLargeFunctions(file: string, text: string, lineLimit: number): Finding[] {
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(file),
  );
  const findings: Finding[] = [];

  visit(sourceFile);
  return findings;

  function visit(node: ts.Node): void {
    if (isFunctionLike(node)) {
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
      const lines = end.line - start.line + 1;

      if (lines > lineLimit) {
        findings.push({
          file,
          line: start.line + 1,
          lines,
          name: functionName(node),
        });
      }
    }

    ts.forEachChild(node, visit);
  }
}

function scriptKindFor(file: string): ts.ScriptKind {
  switch (path.extname(file)) {
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.tsx':
      return ts.ScriptKind.TSX;
    default:
      return ts.ScriptKind.TS;
  }
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isArrowFunction(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function functionName(node: ts.FunctionLikeDeclaration): string {
  const namedNode = node as ts.FunctionLikeDeclaration & { name?: ts.PropertyName };
  if (namedNode.name) {
    return namedNode.name.getText();
  }

  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }

  if (ts.isPropertyAssignment(parent)) {
    return parent.name.getText();
  }

  return '<anonymous>';
}

function printReport(input: {
  scannedFiles: number;
  largeFiles: Finding[];
  largeFunctions: Finding[];
}): void {
  console.log('Maintainability report (report-only)');
  console.log(`Scanned ${input.scannedFiles} tracked source files.`);
  console.log(`Large file threshold: > ${fileLineLimit} lines.`);
  console.log(`Large function threshold: > ${functionLineLimit} lines.`);
  console.log('');

  printFindings('Large files', input.largeFiles, (finding) =>
    `${finding.file} (${finding.lines} lines)`,
  );
  console.log('');
  printFindings('Large functions', input.largeFunctions, (finding) =>
    `${finding.file}:${finding.line} ${finding.name} (${finding.lines} lines)`,
  );
  console.log('');
  console.log('Report-only: findings do not fail validation yet.');
}

function printFindings(
  heading: string,
  findings: Finding[],
  formatFinding: (finding: Finding) => string,
): void {
  console.log(`${heading}: ${findings.length}`);

  if (findings.length === 0) {
    console.log('  None.');
    return;
  }

  for (const finding of findings.slice(0, maxFindings)) {
    console.log(`  - ${formatFinding(finding)}`);
  }

  if (findings.length > maxFindings) {
    console.log(`  ... ${findings.length - maxFindings} more omitted.`);
  }
}
