import ts from "typescript";
import { posix } from "node:path";
import { encodeGraphId, fileId, graphEdge, graphNode, routeId, symbolId, tableId } from "./graph-builders";
import type { CodeIntelligencePass, PassOutput, SourceInput } from "./pass";
import type { GraphEdgeInput, GraphNodeInput, ParserOptions, Provenance, RepositoryDefinition } from "./types";

export const TYPESCRIPT_ADAPTER = { adapter: "typescript-compiler-api", version: ts.version, pass: "symbols-calls-http-data" };
export { fileId, routeId, symbolId } from "./graph-builders";

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const DEFAULT_API_CALLS = new Set(["fetch", "request", "get", "post", "put", "patch", "delete"]);

function provenance(repo: RepositoryDefinition, commit: string, path: string, source: ts.SourceFile, value: ts.Node, confidence: number, evidence: string): Provenance {
  const start = source.getLineAndCharacterOfPosition(value.getStart(source));
  const end = source.getLineAndCharacterOfPosition(value.getEnd());
  return { repository: repo.repositoryId, commit, path, range: { startLine: start.line + 1, startColumn: start.character + 1, endLine: end.line + 1, endColumn: end.character + 1 }, parser: TYPESCRIPT_ADAPTER, confidence, evidence };
}

function resolveImportPath(path: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const raw = posix.normalize(posix.join(posix.dirname(path), specifier));
  if (raw === ".." || raw.startsWith("../")) return null;
  return /\.[cm]?[jt]sx?$/.test(raw) ? raw : `${raw}.ts`;
}

function propertyName(value: ts.PropertyName | ts.BindingName | undefined): string | null {
  if (!value) return null;
  if (ts.isIdentifier(value) || ts.isStringLiteral(value) || ts.isNumericLiteral(value)) return value.text;
  return null;
}

function hasExportModifier(value: ts.Node | undefined): boolean {
  return Boolean(value && ts.canHaveModifiers(value)
    && ts.getModifiers(value)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function callableName(value: ts.Node): string | null {
  if (ts.isFunctionDeclaration(value) || ts.isMethodDeclaration(value) || ts.isMethodSignature(value)) return propertyName(value.name);
  if (ts.isConstructorDeclaration(value)) return "constructor";
  if (ts.isFunctionExpression(value) || ts.isArrowFunction(value)) {
    if (ts.isFunctionExpression(value) && value.name) return value.name.text;
    const parent = value.parent;
    if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) return propertyName(parent.name);
    if (ts.isCallExpression(parent)) {
      const index = parent.arguments.indexOf(value as ts.Expression);
      const callee = parent.expression.getText();
      return `${callee.replace(/[^A-Za-z0-9_$]+/g, ".")}.callback${index}`;
    }
  }
  return null;
}

function isCallable(value: ts.Node): value is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(value) || ts.isMethodDeclaration(value) || ts.isConstructorDeclaration(value) || ts.isFunctionExpression(value) || ts.isArrowFunction(value);
}

function memberPath(value: ts.Expression): string | null {
  if (ts.isIdentifier(value)) return value.text;
  if (ts.isPropertyAccessExpression(value)) {
    const parent = memberPath(value.expression);
    return parent ? `${parent}.${value.name.text}` : value.name.text;
  }
  return null;
}

function staticString(value: ts.Expression | undefined, constants: Map<string, string>): string | null {
  if (!value) return null;
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (ts.isIdentifier(value)) return constants.get(value.text) ?? `:${value.text}`;
  if (ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === "encodeURIComponent") return staticString(value.arguments[0], constants);
  if (ts.isParenthesizedExpression(value)) return staticString(value.expression, constants);
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(value.left, constants);
    const right = staticString(value.right, constants);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isTemplateExpression(value)) {
    let output = value.head.text;
    for (const span of value.templateSpans) {
      const expression = staticString(span.expression, constants);
      output += expression ?? `:${span.expression.getText().replace(/[^A-Za-z0-9_]+/g, "_")}`;
      output += span.literal.text;
    }
    return output;
  }
  return null;
}

export function normalizeApiPath(value: string): string {
  let path = value.replace(/^https?:\/\/[^/]+/, "").split(/[?#]/, 1)[0] ?? value;
  path = path.replace(/\$\{([^}]+)\}/g, (_match, expression) => `:${String(expression).split(".").at(-1)?.replace(/[^A-Za-z0-9_]/g, "_")}`);
  path = path.replace(/\/+/g, "/");
  if (!path.startsWith("/")) path = `/${path}`;
  return path.replace(/:encodeURIComponent\(([^)]+)\)/g, ":$1");
}

function methodFromFetch(call: ts.CallExpression, constants: Map<string, string>): string {
  const options = call.arguments[1];
  if (options && ts.isObjectLiteralExpression(options)) {
    const method = options.properties.find((item): item is ts.PropertyAssignment => ts.isPropertyAssignment(item) && propertyName(item.name) === "method");
    const value = method ? staticString(method.initializer, constants) : null;
    if (value) return value.toUpperCase();
  }
  return "GET";
}

function addUnique<T extends { external_id: string }>(target: T[], value: T): void {
  if (!target.some((item) => item.external_id === value.external_id)) target.push(value);
}

export interface ParsedFile extends PassOutput {}

export function parseTypeScriptFile(repo: RepositoryDefinition, commit: string, path: string, text: string, options: ParserOptions = {}): ParsedFile {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : path.endsWith(".jsx") ? ts.ScriptKind.JSX : path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const nodes: GraphNodeInput[] = [];
  const edges: GraphEdgeInput[] = [];
  const unresolved: ParsedFile["unresolved"] = [];
  const owner = fileId(repo, path);
  const isTest = /(^|\/)(__tests__\/|[^/]+\.(test|spec)\.[cm]?[jt]sx?$)/.test(path);
  const constants = new Map<string, string>();
  const declarations = new Map<string, string>();
  const callableOwners = new Map<ts.Node, string>();
  const imported = new Map<string, { targetPath: string | null; importedName: string; namespace: boolean; moduleId: string }>();
  addUnique(nodes, graphNode(owner, "file", ["File", ...(isTest ? ["Test"] : [])], { path, extension: posix.extname(path), test: isTest, provenance: provenance(repo, commit, path, source, source, 1, "git tree path") }));

  const discover = (current: ts.Node, ownership: string[]): void => {
    if (ts.isImportDeclaration(current) && ts.isStringLiteral(current.moduleSpecifier)) {
      const specifier = current.moduleSpecifier.text;
      const targetPath = resolveImportPath(path, specifier);
      const moduleId = `${owner}:module:${encodeGraphId(specifier)}`;
      addUnique(nodes, graphNode(moduleId, "module_reference", ["ModuleReference"], { specifier, resolved_path: targetPath, provenance: provenance(repo, commit, path, source, current, targetPath ? 0.9 : 1, "static import declaration") }));
      addUnique(edges, graphEdge(`${owner}:imports:${encodeGraphId(specifier)}`, owner, moduleId, isTest ? "TESTS" : "IMPORTS", { specifier, resolved_path: targetPath, provenance: provenance(repo, commit, path, source, current, targetPath ? 0.9 : 1, "static import declaration") }));
      const clause = current.importClause;
      if (clause?.name) imported.set(clause.name.text, { targetPath, importedName: "default", namespace: false, moduleId });
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) imported.set(clause.namedBindings.name.text, { targetPath, importedName: "*", namespace: true, moduleId });
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const item of clause.namedBindings.elements) imported.set(item.name.text, { targetPath, importedName: item.propertyName?.text ?? item.name.text, namespace: false, moduleId });
      }
    }
    if (ts.isExportDeclaration(current) && current.exportClause && ts.isNamedExports(current.exportClause)) {
      const specifier = current.moduleSpecifier && ts.isStringLiteral(current.moduleSpecifier) ? current.moduleSpecifier.text : null;
      const targetPath = specifier ? resolveImportPath(path, specifier) : null;
      for (const item of current.exportClause.elements) {
        const exportedName = item.name.text;
        const originalName = item.propertyName?.text ?? exportedName;
        const id = symbolId(repo, path, exportedName);
        addUnique(nodes, graphNode(id, "declaration", ["Symbol", "Exported"], { name: exportedName, qualified_name: exportedName, kind: "ReExport", exported: true, callable: false, path, provenance: provenance(repo, commit, path, source, item, 1, "static named re-export") }));
        addUnique(edges, graphEdge(`${id}:declared_in`, id, owner, "DECLARED_IN", { provenance: provenance(repo, commit, path, source, item, 1, "AST parent file") }));
        declarations.set(exportedName, declarations.get(exportedName) ?? id);
        if (targetPath) {
          const target = symbolId(repo, targetPath, originalName);
          addUnique(edges, graphEdge(`${id}:resolves_to:${target}`, id, target, "RESOLVES_TO", { provenance: provenance(repo, commit, path, source, item, 0.98, "static named re-export target") }));
        }
      }
    }
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.initializer) {
      const value = staticString(current.initializer, constants);
      if (value && !value.startsWith(":")) constants.set(current.name.text, value);
    }
    let nextOwnership = ownership;
    const functionProperty = (ts.isPropertyAssignment(current) || ts.isPropertyDeclaration(current)) && current.initializer && (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer));
    const name = isCallable(current) ? callableName(current) : ts.isClassDeclaration(current) ? propertyName(current.name) : functionProperty ? propertyName(current.name) : null;
    const declarationNode = isCallable(current) || ts.isClassDeclaration(current) || ts.isInterfaceDeclaration(current) || ts.isTypeAliasDeclaration(current) || ts.isEnumDeclaration(current) || functionProperty;
    if (declarationNode && name) {
      const qualifiedName = [...ownership, name].join(".");
      const id = symbolId(repo, path, qualifiedName);
      const exported = hasExportModifier(current) || hasExportModifier(current.parent?.parent);
      const callable = isCallable(current) || Boolean(functionProperty);
      addUnique(nodes, graphNode(id, callable ? "callable" : "declaration", ["Symbol", ...(callable ? ["Callable"] : []), ...(exported ? ["Exported"] : [])], { name, qualified_name: qualifiedName, kind: ts.SyntaxKind[current.kind], exported, callable, path, provenance: provenance(repo, commit, path, source, current, 1, "AST declaration with lexical ownership") }));
      addUnique(edges, graphEdge(`${id}:declared_in`, id, owner, "DECLARED_IN", { provenance: provenance(repo, commit, path, source, current, 1, "AST parent file") }));
      if (ownership.length) {
        const parent = declarations.get(ownership.join("."));
        if (parent) addUnique(edges, graphEdge(`${id}:owned_by:${parent}`, id, parent, "OWNED_BY", { provenance: provenance(repo, commit, path, source, current, 1, "lexical declaration ownership") }));
      }
      declarations.set(qualifiedName, id);
      declarations.set(name, declarations.get(name) ?? id);
      if (isCallable(current)) callableOwners.set(current, id);
      if (functionProperty && current.initializer) callableOwners.set(current.initializer, id);
      nextOwnership = [...ownership, name];
    } else if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.initializer && (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))) {
      const qualifiedName = [...ownership, current.name.text].join(".");
      const id = symbolId(repo, path, qualifiedName);
      const component = /^[A-Z]/.test(current.name.text) && /\.[jt]sx$/.test(path);
      const exported = ts.isVariableStatement(current.parent.parent) && Boolean(current.parent.parent.modifiers?.some((item) => item.kind === ts.SyntaxKind.ExportKeyword));
      addUnique(nodes, graphNode(id, component ? "ui_component" : "callable", ["Callable", "Symbol", ...(component ? ["UIComponent"] : []), ...(exported ? ["Exported"] : [])], { name: current.name.text, qualified_name: qualifiedName, kind: "VariableFunction", exported, callable: true, path, provenance: provenance(repo, commit, path, source, current, component ? 0.95 : 1, component ? "function-valued JSX component" : "function-valued variable declaration") }));
      addUnique(edges, graphEdge(`${id}:declared_in`, id, owner, "DECLARED_IN", { provenance: provenance(repo, commit, path, source, current, 1, "AST parent file") }));
      declarations.set(qualifiedName, id); declarations.set(current.name.text, declarations.get(current.name.text) ?? id); callableOwners.set(current.initializer, id);
      nextOwnership = [...ownership, current.name.text];
    } else if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      const qualifiedName = [...ownership, current.name.text].join(".");
      const id = symbolId(repo, path, qualifiedName);
      const exported = ts.isVariableStatement(current.parent.parent) && Boolean(current.parent.parent.modifiers?.some((item) => item.kind === ts.SyntaxKind.ExportKeyword));
      addUnique(nodes, graphNode(id, "declaration", ["Symbol", ...(exported ? ["Exported"] : [])], { name: current.name.text, qualified_name: qualifiedName, kind: "VariableDeclaration", exported, callable: false, path, provenance: provenance(repo, commit, path, source, current, 1, "AST variable declaration") }));
      addUnique(edges, graphEdge(`${id}:declared_in`, id, owner, "DECLARED_IN", { provenance: provenance(repo, commit, path, source, current, 1, "AST parent file") }));
      declarations.set(qualifiedName, id); declarations.set(current.name.text, declarations.get(current.name.text) ?? id);
      if (current.initializer && ts.isObjectLiteralExpression(current.initializer)) nextOwnership = [...ownership, current.name.text];
    }
    ts.forEachChild(current, (child) => discover(child, nextOwnership));
  };
  discover(source, []);

  const callerFor = (value: ts.Node): string => {
    for (let current: ts.Node | undefined = value; current; current = current.parent) {
      const callable = callableOwners.get(current);
      if (callable) return callable;
    }
    return owner;
  };
  const resolveCall = (expression: ts.Expression): { id: string; evidence: string; confidence: number } | null => {
    const pathName = memberPath(expression);
    if (!pathName) return null;
    const exact = declarations.get(pathName);
    if (exact) return { id: exact, evidence: "lexically resolved callable", confidence: 0.98 };
    const [root, ...members] = pathName.split(".");
    const binding = imported.get(root!);
    if (binding?.targetPath) {
      // Namespace members identify exported callables (`api.createMessage`). A
      // member invoked on a named/default import (`OPTIONS.filter`) is runtime
      // object behaviour, not an exported symbol called `OPTIONS.filter`.
      const namespaceMembers = ["call", "apply", "bind"].includes(members.at(-1) ?? "") ? members.slice(0, -1) : members;
      const importedName = binding.namespace
        ? namespaceMembers.join(".")
        : members.length === 0 && binding.importedName !== "default"
          ? binding.importedName
          : "";
      if (importedName) return { id: symbolId(repo, binding.targetPath, importedName), evidence: "statically resolved imported callable", confidence: 0.95 };
    }
    const local = declarations.get(pathName.split(".").at(-1) ?? pathName);
    if (local) return { id: local, evidence: "lexically resolved callable", confidence: 0.96 };
    return null;
  };
  const visit = (current: ts.Node): void => {
    if (ts.isCallExpression(current)) {
      const caller = callerFor(current);
      const callName = memberPath(current.expression) ?? current.expression.getText(source);
      const resolved = resolveCall(current.expression);
      if (resolved) addUnique(edges, graphEdge(`${caller}:calls:${encodeGraphId(callName)}:${current.getStart(source)}`, caller, resolved.id, "CALLS", { callee: callName, provenance: provenance(repo, commit, path, source, current, resolved.confidence, resolved.evidence) }));
      else if (!ts.isPropertyAccessExpression(current.expression) || !HTTP_METHODS.has(current.expression.name.text.toUpperCase())) {
        const line = source.getLineAndCharacterOfPosition(current.getStart(source)).line + 1;
        unresolved.push({ path, line, kind: "call", expression: callName });
      }
      if (ts.isPropertyAccessExpression(current.expression)) {
        const method = current.expression.name.text.toUpperCase();
        const route = staticString(current.arguments[0], constants);
        const routeObject = memberPath(current.expression.expression) ?? "";
        const allowedRouter = !options.routeObjectNames?.length || options.routeObjectNames.includes(routeObject.split(".")[0]!);
        if (HTTP_METHODS.has(method) && route?.startsWith("/") && allowedRouter && current.arguments.length >= 2) {
          const normalized = normalizeApiPath(route);
          const id = routeId(repo, method, normalized);
          addUnique(nodes, graphNode(id, "http_route", ["HttpRoute"], { method, route: normalized, path, provenance: provenance(repo, commit, path, source, current, 0.98, "static Hono-style route declaration") }));
          addUnique(edges, graphEdge(`${owner}:declares_route:${method}:${encodeGraphId(normalized)}`, owner, id, "DECLARES_ROUTE", { provenance: provenance(repo, commit, path, source, current, 0.98, "static router declaration") }));
          const handler = resolveCall(current.arguments.at(-1)!);
          if (handler) addUnique(edges, graphEdge(`${id}:handled_by:${handler.id}`, id, handler.id, "HANDLED_BY", { provenance: provenance(repo, commit, path, source, current.arguments.at(-1)!, handler.confidence, handler.evidence) }));
        }
      }
      const shortName = callName.split(".").at(-1)?.toLowerCase() ?? "";
      const apiNames = new Set([...DEFAULT_API_CALLS, ...(options.apiCallNames ?? []).map((item) => item.toLowerCase())]);
      if (apiNames.has(shortName)) {
        const raw = staticString(current.arguments[0], constants);
        if (raw?.includes("/")) {
          const route = normalizeApiPath(raw);
          const method = shortName === "fetch" || shortName === "request" ? methodFromFetch(current, constants) : shortName.toUpperCase();
          const consumerId = `${owner}:api-consumer:${method}:${encodeGraphId(route)}:${current.getStart(source)}`;
          addUnique(nodes, graphNode(consumerId, "api_consumer", ["ApiConsumer"], { method, route, callee: callName, path, provenance: provenance(repo, commit, path, source, current, 0.94, "statically evaluated API client call") }));
          addUnique(edges, graphEdge(`${caller}:consumes_api:${consumerId}`, caller, consumerId, "CONSUMES_API", { method, route, provenance: provenance(repo, commit, path, source, current, 0.94, "enclosing callable invokes API consumer") }));
          const configured = options.externalRoutes?.[`${method} ${route}`] ?? options.externalRoutes?.[`* ${route}`];
          const legacyConfigured = options.externalRoutes?.[`${shortName.toUpperCase()} ${route}`] ?? configured;
          if (legacyConfigured) {
            addUnique(edges, graphEdge(`${caller}:api-configured:${legacyConfigured}:${current.getStart(source)}`, caller, legacyConfigured, "CONSUMES_API", { method, route, provenance: provenance(repo, commit, path, source, current, 0.98, "configured exact route match") }));
            addUnique(edges, graphEdge(`${consumerId}:matches:${legacyConfigured}`, consumerId, legacyConfigured, "MATCHES_ROUTE", { method, route, provenance: provenance(repo, commit, path, source, current, 0.98, "configured exact route match") }));
          }
        }
      }
      const sqlName = callName.split(".").at(-1)?.toLowerCase() ?? "";
      const sqlCalls = new Set(["from", "selectfrom", "insert", "insertinto", "update", "deletefrom", ...(options.sqlCallNames ?? []).map((item) => item.toLowerCase())]);
      if (sqlCalls.has(sqlName)) {
        const table = current.arguments[0] && ts.isIdentifier(current.arguments[0]) ? current.arguments[0].text : staticString(current.arguments[0], constants);
        if (table && /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(table)) {
          const id = tableId(repo, table);
          const writes = /^(insert|insertinto|update|deletefrom)$/.test(sqlName);
          addUnique(nodes, graphNode(id, "data_table", ["DataStore", "Table"], { name: table, path, provenance: provenance(repo, commit, path, source, current, 0.95, "deterministic query-builder table reference") }));
          addUnique(edges, graphEdge(`${caller}:${writes ? "writes" : "reads"}:${id}:${current.getStart(source)}`, caller, id, writes ? "WRITES_TO" : "READS_FROM", { operation: sqlName, provenance: provenance(repo, commit, path, source, current, 0.95, "query-builder operation") }));
        }
      }
      if (shortName === "parse" || shortName === "safeparse") {
        const schema = ts.isPropertyAccessExpression(current.expression) ? memberPath(current.expression.expression) : null;
        const schemaTarget = schema ? declarations.get(schema) : null;
        if (schemaTarget) addUnique(edges, graphEdge(`${caller}:validated_by:${schemaTarget}:${current.getStart(source)}`, caller, schemaTarget, "VALIDATED_BY", { provenance: provenance(repo, commit, path, source, current, 0.9, "schema parse invocation") }));
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(source);
  return { nodes, edges, unresolved };
}

export const typescriptPass: CodeIntelligencePass = {
  metadata: TYPESCRIPT_ADAPTER,
  supports: (path) => /\.[cm]?[jt]sx?$/.test(path),
  parse: (input: SourceInput) => parseTypeScriptFile(input.repository, input.commit, input.path, input.text, input.options),
};
