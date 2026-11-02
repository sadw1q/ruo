#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(process.env.RUO_CODING_AGENT_DIR || join(homedir(), ".ruo", "agent"));
mkdirSync(target, { recursive: true });
const settingsPath = join(target, "settings.json");
const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("settings.json must be an object");
for (const category of ["extensions", "themes"]) {
  mkdirSync(join(target, category), { recursive: true });
  for (const name of readdirSync(join(root, category))) {
    const dest = join(target, category, name);
    if (existsSync(dest)) continue;
    cpSync(join(root, category, name), dest, { recursive: true, force: false, errorOnExist: true });
  }
}
if (!settings.theme) settings.theme = "claude-dark-orange-user";
writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
console.log(`Ruo setup complete: ${target}`);
