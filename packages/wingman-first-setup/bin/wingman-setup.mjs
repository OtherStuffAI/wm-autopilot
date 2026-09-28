#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const skillName = 'wingman-first-setup';
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skill', skillName);
const version = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;

function usage() {
  return `Wingman first setup installer v${version}

Usage: npx @wingmanbefree/setup [--target codex|claude] [--skills-dir PATH] [--force] [--dry-run]

Options:
  --target       Agent to install for (default: codex)
  --skills-dir   Parent directory for skills; overrides --target
  --force        Replace an existing copy after making a backup
  --dry-run      Show the destination without changing files
  --help         Show this help
  --version      Show the package version
`;
}

function fail(message) {
  console.error(`wingman-setup: ${message}`);
  process.exitCode = 1;
}

function expandHome(path) {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

function parseArgs(args) {
  const options = { target: 'codex', skillsDir: null, force: false, dryRun: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return { action: 'help' };
    if (arg === '--version' || arg === '-v') return { action: 'version' };
    if (arg === '--force') options.force = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--target' || arg === '--skills-dir') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--target') options.target = value;
      else options.skillsDir = value;
    } else throw new Error(`unknown option ${arg}`);
  }
  if (!['codex', 'claude'].includes(options.target)) throw new Error('target must be codex or claude');
  return options;
}

function destinationFor(options) {
  const parent = options.skillsDir
    ? resolve(expandHome(options.skillsDir))
    : join(homedir(), options.target === 'claude' ? '.claude' : '.codex', 'skills');
  return join(parent, skillName);
}

function sameSkill(destination) {
  const files = ['SKILL.md', join('agents', 'openai.yaml')];
  return files.every((file) => {
    const installed = join(destination, file);
    return existsSync(installed) && readFileSync(installed).equals(readFileSync(join(source, file)));
  });
}

function install(options) {
  const destination = destinationFor(options);
  if (options.dryRun) {
    console.log(`Would install ${skillName} to ${destination}`);
    return;
  }
  if (existsSync(destination) && sameSkill(destination)) {
    console.log(`${skillName} is already installed at ${destination}`);
    return;
  }
  if (existsSync(destination) && !options.force) {
    throw new Error(`${destination} already exists. Use --force to back it up and replace it.`);
  }

  mkdirSync(dirname(destination), { recursive: true });
  const staging = mkdtempSync(join(dirname(destination), `.${skillName}-`));
  const stagedSkill = join(staging, skillName);
  let backup = null;
  try {
    cpSync(source, stagedSkill, { recursive: true });
    if (existsSync(destination)) {
      backup = join(dirname(destination), `${basename(destination)}.backup-${Date.now()}`);
      renameSync(destination, backup);
    }
    try {
      renameSync(stagedSkill, destination);
    } catch (error) {
      if (backup) renameSync(backup, destination);
      throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  console.log(`Installed ${skillName} to ${destination}`);
  if (backup) console.log(`Previous copy backed up to ${backup}`);
  console.log('Next: ask your agent, "Use wingman-first-setup to set up my Wingman."');
  console.log('The skill will ask for Docker or Bun, transport, Tower workspace, and bot choices.');
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.action === 'help') console.log(usage());
  else if (options.action === 'version') console.log(version);
  else install(options);
} catch (error) {
  fail(error.message);
}
