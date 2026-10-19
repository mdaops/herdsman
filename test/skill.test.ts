import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
// Exercise the pinned skill parser without bootstrapping Pi's unrelated extension runtime.
import {
  formatSkillsForPrompt,
  loadSkillsFromDir,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js";

test("canonical skill is discoverable directly and through a personal-directory symlink", async () => {
  const canonical = fileURLToPath(new URL("../skills/herdsman/", import.meta.url));
  const personal = await mkdtemp(join(tmpdir(), "herdsman-skill-"));
  try {
    await symlink(canonical, join(personal, "herdsman"));
    for (const dir of [canonical, personal]) {
      const result = loadSkillsFromDir({ dir, source: "test" });
      assert.deepEqual(result.diagnostics, []);
      assert.equal(result.skills.length, 1);
      const [skill] = result.skills;
      assert.equal(skill.name, "herdsman");
      assert.match(skill.description, /named coordinators/);
      assert.equal(skill.disableModelInvocation, false);
      assert.equal(await realpath(skill.filePath), await realpath(join(canonical, "SKILL.md")));
      assert.match(formatSkillsForPrompt(result.skills), /<name>herdsman<\/name>/);
    }
  } finally {
    await rm(personal, { recursive: true, force: true });
  }
});
