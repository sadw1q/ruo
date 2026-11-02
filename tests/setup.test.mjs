import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
test("setup preserves user settings and extensions", () => {
 const dir = mkdtempSync(join(tmpdir(), "ruo-test-"));
 try {
  const run = () => spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/setup.mjs", import.meta.url))], { env: { ...process.env, RUO_CODING_AGENT_DIR: dir }, encoding: "utf8" });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.ok(existsSync(join(dir, "extensions/coding-assistant/index.ts")));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ theme: "custom", custom: true }));
  const file = join(dir, "extensions/markdown-fences.ts");
  writeFileSync(file, "custom");
  assert.equal(run().status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")), { theme: "custom", custom: true });
  assert.equal(readFileSync(file, "utf8"), "custom");
 } finally { rmSync(dir, { recursive: true, force: true }); }
});
