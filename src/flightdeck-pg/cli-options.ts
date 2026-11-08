type Flags = Map<string, string | boolean>;
const common = "help json bot-crypto key session-id url tower-url app-npub workspace";
const booleanFlags = new Set("help json bot-crypto no-comments no-storage object public confirm all".split(" "));
// Each command declares only the options it actually consumes.
const commands: Record<string, string> = {
  context: "", status: "", "workspaces list": "", "workspace show": "", "workspace me": "",
  "scopes list": "", "scope show": "", "channels list": "scope limit", "channel show": "",
  "threads list": "channel limit cursor", "thread read": "channel limit", "thread create": "channel body mentions-json", "chat create": "channel body mentions-json", "thread rename": "title", "chat reply": "channel thread body mentions-json",
  "tasks list": "channel scope cursor limit", "task show": "", "task create": "channel title body description state priority thread", "task patch": "json-file", "task move": "destination-channel destination-scope", "task state": "state", "task comments": "limit cursor all", "task comment": "body thread mentions-json", "task assign": "agent",
  "docs list": "channel limit cursor", "doc create": "channel title body-file", "doc show": "body", "doc download": "out no-comments no-storage", "doc-download": "out no-comments no-storage", "doc update": "body-file base-row-version base-version-id base-body-sha256-hex", "doc move": "destination-channel destination-scope", "doc comments": "limit cursor all", "doc reply": "body comment mentions-json",
  "files list": "channel limit cursor", "file upload": "channel path content-type", "file show": "object", "file download": "out", "file blossom": "", "file publish": "version public", "file unpublish": "version", "attachment blossom": "message", "attachment publish": "message public", "attachment unpublish": "message",
  "audio create": "channel file content-type", "reactions create": "target emoji", "events poll": "since limit", "members list": "",
  "workrooms list": "scope channel status limit", "workrooms search": "query scope channel limit", "workroom show": "limit", "workroom events": "limit", "workroom event": "type title body target-type target-ref visibility payload-file", "workroom links": "limit", "workroom link": "link-type target-type target-id external-url label status metadata-file", "workroom approval-request": "repo from-branch to-branch commit preview-url validation title summary reviewer-npub metadata-file", "workroom production-merge-check": "repo to-branch commit", "approvals list": "target-type target-id action status limit", "approval show": "",
  "context-tree list": "scope limit", "context-tree read": "scope", "context-tree path": "scope", "context-tree references": "scope limit", "context-tree reference": "scope reference", "context-tree create": "scope json-file", "context-tree update": "scope json-file", "context-tree link": "scope json-file", "context-tree unlink": "scope reference expected-row-version", "context-tree delete-preview": "scope", "context-tree confirmed-delete": "scope confirmation-token confirm", "context-tree help": "",
};
commands["context-tree delete_preview"] = commands["context-tree delete-preview"]!;
commands["context-tree confirmed_delete"] = commands["context-tree confirmed-delete"]!;
const noId = new Set("context|status|workspaces list|scopes list|channels list|threads list|thread create|chat create|chat reply|tasks list|task create|docs list|doc create|files list|file upload|audio create|reactions create|events poll|members list|workrooms list|workrooms search|approvals list|context-tree list|context-tree create|context-tree help".split("|"));

function parseOptions(argv: string[], bodySwitch: boolean): { positionals: string[]; flags: Flags } {
  const flags: Flags = new Map();
  const positionals: string[] = [];
  const known = new Set((common + " " + Object.values(commands).join(" ")).split(" "));
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith("-")) { positionals.push(arg); continue; }
    const name = arg.slice(2);
    if (!arg.startsWith("--") || !known.has(name)) throw new Error(`Unknown option: ${arg}`);
    if (flags.has(arg)) throw new Error(`Duplicate option: ${arg}`);
    if (booleanFlags.has(name)) { flags.set(arg, true); continue; }
    if (name === "body" && bodySwitch) { flags.set(arg, true); continue; }
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
    flags.set(arg, value);
  }
  if (!positionals.length || positionals[0] === "help") {
    if (positionals.length > 1) throw new Error("Surplus arguments after help.");
    return { positionals, flags };
  }
  const command = ["context", "status", "doc-download"].includes(positionals[0]!) ? positionals[0]! : positionals.slice(0, 2).join(" ");
  if (!Object.hasOwn(commands, command)) throw new Error(`Unknown flightdeck command: ${command}`);
  if (flags.has("--body") && (command === "doc show") !== (flags.get("--body") === true)) throw new Error("--body is a switch for doc show and requires text for writes.");
  const allowed = new Set((common + " " + commands[command]).split(" ").map(name => `--${name}`));
  for (const flag of flags.keys()) if (!allowed.has(flag)) throw new Error(`Unsupported option ${flag} for ${command}.`);
  const max = command === "doc-download" ? 3 : command.split(" ").length + (noId.has(command) ? 0 : 1);
  if (positionals.length > max) throw new Error(`Surplus arguments for ${command}: ${positionals.slice(max).join(" ")}`);
  return { positionals, flags };
}

export function parseFlightDeckOptions(argv: string[]) {
  try { return parseOptions(argv, false); }
  catch (error) {
    // The only overloaded option is doc show's body switch. Validate the full
    // alternate parse; command words inside option values cannot select it.
    if (!argv.includes("--body")) throw error;
    try {
      const alternate = parseOptions(argv, true);
      if (alternate.positionals[0] === "doc" && alternate.positionals[1] === "show") return alternate;
    } catch { /* Preserve the ordinary parse error. */ }
    throw error;
  }
}
