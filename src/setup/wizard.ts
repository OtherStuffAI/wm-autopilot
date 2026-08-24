import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_PORT = 3600;
const DEFAULT_AGENT_PORTS = 3700;
const DEFAULT_AGENT_MAX = 10;
const DEFAULT_DIRECTORY = "~/code";

const SETUP_DB_PATH = new URL("../../data/setup.db", import.meta.url).pathname;

const getSetupDb = (): Database => {
  mkdirSync(dirname(SETUP_DB_PATH), { recursive: true });
  const db = new Database(SETUP_DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS setup_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  return db;
};

const isWizardComplete = (): boolean => {
  const db = getSetupDb();
  const row = db.query<{ value: string }, string>(
    "SELECT value FROM setup_state WHERE key = ?1"
  ).get("wizard_complete");
  db.close();
  return row?.value === "true";
};

const markWizardComplete = (): void => {
  const db = getSetupDb();
  const now = new Date().toISOString();
  db.run(
    `INSERT OR REPLACE INTO setup_state (key, value, created_at) VALUES (?1, ?2, ?3)`,
    ["wizard_complete", "true", now]
  );
  db.close();
};

const findProjectRoot = (): string => {
  let dir = process.cwd();
  while (dir !== "/") {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    dir = join(dir, "..");
  }
  return process.cwd();
};

const generateSecureSecret = (): string => {
  return randomBytes(48).toString("base64url");
};

const readEnvFile = (envPath: string): Map<string, string> => {
  const env = new Map<string, string>();
  if (!existsSync(envPath)) {
    return env;
  }
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Remove quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env.set(key, value);
  }
  return env;
};

const writeEnvFile = (envPath: string, values: Map<string, string>): void => {
  const projectRoot = findProjectRoot();
  const examplePath = join(projectRoot, ".env.example");

  let content = "";
  if (existsSync(examplePath)) {
    // Use .env.example as template
    const template = readFileSync(examplePath, "utf-8");
    const lines = template.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        content += line + "\n";
        continue;
      }
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) {
        content += line + "\n";
        continue;
      }
      const key = trimmed.slice(0, eqIndex).trim();
      if (values.has(key)) {
        content += `${key}=${values.get(key)}\n`;
      } else {
        content += line + "\n";
      }
    }
  } else {
    // Create from scratch
    for (const [key, value] of values) {
      content += `${key}=${value}\n`;
    }
  }

  writeFileSync(envPath, content);
};

const loadEnvIntoRuntime = (values: Map<string, string>): void => {
  for (const [key, value] of values) {
    if (value) {
      Bun.env[key] = value;
      process.env[key] = value;
    }
  }
};

type SetupEnvironment = Record<string, string | undefined>;

const readConfiguredValue = (
  values: Map<string, string>,
  key: string,
  env: SetupEnvironment = process.env,
): string => {
  return values.get(key)?.trim() || env[key]?.trim() || "";
};

const readFirstConfiguredValue = (
  values: Map<string, string>,
  keys: string[],
  env: SetupEnvironment = process.env,
): string => {
  for (const key of keys) {
    const value = readConfiguredValue(values, key, env);
    if (value) {
      return value;
    }
  }
  return "";
};

const isTruthySetting = (value: string | undefined): boolean => {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
};

const shouldRunNonInteractiveSetup = (values: Map<string, string>): boolean => {
  return isTruthySetting(readConfiguredValue(values, "WINGMAN_SETUP_NONINTERACTIVE"));
};

export const validateNonInteractiveSetupConfig = (
  values: Map<string, string>,
  env: SetupEnvironment = process.env,
): string[] => {
  const required = [
    {
      name: "DIRECTORY_DEF",
      value: readFirstConfiguredValue(values, ["DIRECTORY_DEF", "WINGMAN_DIRECTORY_DEF"], env),
    },
    {
      name: "IDENTITY_SESSION_SECRET",
      value: readFirstConfiguredValue(values, ["IDENTITY_SESSION_SECRET", "WINGMAN_IDENTITY_SESSION_SECRET"], env),
    },
    {
      name: "ADMIN_NPUB",
      value: readFirstConfiguredValue(values, ["ADMIN_NPUB", "WINGMAN_ADMIN_NPUB"], env),
    },
  ];

  return required
    .filter((entry) => !entry.value)
    .map((entry) => entry.name);
};

const normalizeNonInteractiveRuntimeEnv = (values: Map<string, string>): void => {
  const directory = readFirstConfiguredValue(values, ["DIRECTORY_DEF", "WINGMAN_DIRECTORY_DEF"]);
  const agentDispatchDirectory = readFirstConfiguredValue(
    values,
    ["AGENT_DISPATCH_DIRECTORY", "WINGMAN_AGENT_DISPATCH_DIRECTORY"],
  );
  const sessionSecret = readFirstConfiguredValue(values, ["IDENTITY_SESSION_SECRET", "WINGMAN_IDENTITY_SESSION_SECRET"]);
  const adminNpub = readFirstConfiguredValue(values, ["ADMIN_NPUB", "WINGMAN_ADMIN_NPUB"]);

  if (directory) values.set("DIRECTORY_DEF", directory);
  if (agentDispatchDirectory) values.set("AGENT_DISPATCH_DIRECTORY", agentDispatchDirectory);
  if (sessionSecret) values.set("IDENTITY_SESSION_SECRET", sessionSecret);
  if (adminNpub) values.set("ADMIN_NPUB", adminNpub);
};

const completeNonInteractiveSetup = (values: Map<string, string>): boolean => {
  const missing = validateNonInteractiveSetupConfig(values);

  if (missing.length > 0) {
    console.warn(
      `[setup] WINGMAN_SETUP_NONINTERACTIVE is set, but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required.`,
    );
    return false;
  }

  normalizeNonInteractiveRuntimeEnv(values);
  loadEnvIntoRuntime(values);
  markWizardComplete();
  console.log("[setup] Non-interactive setup complete.");
  return true;
};

const promptWithDefault = async (
  rl: ReturnType<typeof createInterface>,
  question: string,
  defaultValue: string
): Promise<string> => {
  const answer = await rl.question(`${question} [${defaultValue}]: `);
  return answer.trim() || defaultValue;
};

const promptRequired = async (
  rl: ReturnType<typeof createInterface>,
  question: string,
  hint?: string
): Promise<string> => {
  const hintText = hint ? ` (${hint})` : "";
  while (true) {
    const answer = await rl.question(`${question}${hintText}: `);
    const trimmed = answer.trim();
    if (trimmed) return trimmed;
    console.log("  This field is required. Please enter a value.");
  }
};

export const runSetupWizard = async (): Promise<boolean> => {
  const projectRoot = findProjectRoot();
  const envPath = join(projectRoot, ".env");
  const existingEnv = readEnvFile(envPath);

  // Check if wizard already completed
  if (isWizardComplete()) {
    loadEnvIntoRuntime(existingEnv);
    return true;
  }

  if (shouldRunNonInteractiveSetup(existingEnv)) {
    return completeNonInteractiveSetup(existingEnv);
  }

  // Check if essential vars are already set
  const hasAdminNpub = readConfiguredValue(existingEnv, "ADMIN_NPUB");
  const hasDirectory = readConfiguredValue(existingEnv, "DIRECTORY_DEF");

  if (hasAdminNpub && hasDirectory) {
    // Essential config exists, mark complete and skip
    loadEnvIntoRuntime(existingEnv);
    markWizardComplete();
    return true;
  }

  console.log("\n" + "=".repeat(60));
  console.log("  Welcome to Wingman Setup Wizard");
  console.log("=".repeat(60));
  console.log("\nThis wizard will help you configure Wingman for first use.\n");

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    const values = new Map<string, string>(existingEnv);

    // ADMIN_NPUB
    console.log("\n--- Admin Identity ---");
    console.log("Your Nostr npub will be the admin account with full access.");
    const adminNpub = await promptRequired(
      rl,
      "Enter your Nostr npub",
      "required"
    );
    values.set("ADMIN_NPUB", adminNpub);

    // DIRECTORY_DEF
    console.log("\n--- Code Directory ---");
    console.log("Default directory where your code projects are located.");
    const directoryDef = await promptWithDefault(
      rl,
      "Code directory",
      existingEnv.get("DIRECTORY_DEF") || DEFAULT_DIRECTORY
    );
    values.set("DIRECTORY_DEF", directoryDef);

    // AGENT_DISPATCH_DIRECTORY
    console.log("\n--- Agent Dispatch Directory ---");
    console.log("Default directory for Flight Deck dispatch agents.");
    const agentDispatchDirectory = await promptWithDefault(
      rl,
      "Agent dispatch directory",
      existingEnv.get("AGENT_DISPATCH_DIRECTORY") || directoryDef
    );
    values.set("AGENT_DISPATCH_DIRECTORY", agentDispatchDirectory);

    // FOLDERACCESS
    console.log("\n--- Folder Access ---");
    console.log("Comma-separated list of directories Wingman can access.");
    const defaultFolders = existingEnv.get("FOLDERACCESS") || `${directoryDef},${agentDispatchDirectory},~/Documents`;
    const folderAccess = await promptWithDefault(
      rl,
      "Allowed folders",
      defaultFolders
    );
    values.set("FOLDERACCESS", folderAccess);

    // PORT
    console.log("\n--- Server Ports ---");
    const port = await promptWithDefault(
      rl,
      "Wingman web UI port",
      existingEnv.get("PORT") || String(DEFAULT_PORT)
    );
    values.set("PORT", port);

    // AGENT_PORTS
    const agentPorts = await promptWithDefault(
      rl,
      "Starting port for agent sessions",
      existingEnv.get("AGENT_PORTS") || String(DEFAULT_AGENT_PORTS)
    );
    values.set("AGENT_PORTS", agentPorts);

    // AGENT_MAX
    const agentMax = await promptWithDefault(
      rl,
      "Maximum concurrent agent sessions",
      existingEnv.get("AGENT_MAX") || String(DEFAULT_AGENT_MAX)
    );
    values.set("AGENT_MAX", agentMax);

    // Auto-generate session secret if not set
    if (!values.get("IDENTITY_SESSION_SECRET")?.trim()) {
      values.set("IDENTITY_SESSION_SECRET", generateSecureSecret());
      console.log("\n[auto] Generated secure session secret");
    }

    // Set sensible defaults for other values
    if (!values.has("AGENTAPI_ALLOWED_HOSTS")) {
      values.set("AGENTAPI_ALLOWED_HOSTS", "localhost,127.0.0.1,[::1]");
    }

    // Write .env file and load into runtime
    console.log("\n--- Saving Configuration ---");
    writeEnvFile(envPath, values);
    loadEnvIntoRuntime(values);
    console.log(`Configuration saved to ${envPath}`);

    // Mark wizard as complete
    markWizardComplete();

    console.log("\n" + "=".repeat(60));
    console.log("  Setup Complete!");
    console.log("=".repeat(60));
    console.log("\nWingman will now start. You can edit .env to change settings.\n");

    rl.close();
    return true;
  } catch (error) {
    rl.close();
    if ((error as NodeJS.ErrnoException).code === "ERR_USE_AFTER_CLOSE") {
      // User pressed Ctrl+C
      console.log("\n\nSetup cancelled. Run Wingman again to continue setup.\n");
      return false;
    }
    throw error;
  }
};
