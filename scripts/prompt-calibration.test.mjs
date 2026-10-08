import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyPromptCalibration, exportPromptCalibrationEvidence, getPromptCalibration, resetPromptCalibration } from "./prompt-calibration.mjs";

const cli = fileURLToPath(new URL("./calibrate-outfit-prompts.mjs", import.meta.url));

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "wardrobe-calibration-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "photo-history"));
  const history = {
    version: 1,
    targets: [{ kind: "outfit", targetId: "navy-denim", mode: "default", activeVersionId: "v2", versions: [
      { id: "v1", image: "/api/import/photo-history/v1.png", createdAt: "2026-10-08T01:00:00Z", status: "accepted", source: "legacy", prompt: "Full original prompt", promptRevisionId: "default", context: { garmentIds: ["top", "bottom"] }, feedback: { rating: "down", comment: "The overshirt hides the hoodie.", updatedAt: "2026-10-08T01:01:00Z" } },
      { id: "v2", image: "/api/import/photo-history/v2.png", createdAt: "2026-10-08T01:02:00Z", status: "accepted", source: "regeneration", prompt: "Full regeneration prompt", promptRevisionId: "default", context: { garmentIds: ["top", "bottom"] }, feedback: { rating: "up", comment: "Better proportion and visible inner layer.", updatedAt: "2026-10-08T01:03:00Z" } },
      { id: "v3", image: "/api/import/photo-history/v3.png", createdAt: "2026-10-08T01:04:00Z", status: "accepted", source: "regeneration", prompt: "Another full prompt", promptRevisionId: "default", context: {}, feedback: null },
    ], events: [
      { id: "e1", type: "feedback", versionId: "v1", rating: "down", comment: "The overshirt hides the hoodie.", at: "2026-10-08T01:01:00Z" },
      { id: "e2", type: "regenerate", versionId: "v2", fromVersionId: "v1", toVersionId: "v2", at: "2026-10-08T01:02:00Z" },
      { id: "e3", type: "undo", versionId: "v2", fromVersionId: "v3", toVersionId: "v2", at: "2026-10-08T01:04:30Z" },
    ] }],
  };
  await writeFile(path.join(directory, "photo-history", "index.json"), JSON.stringify(history));
  await writeFile(path.join(directory, "photo-history", "v1.png"), "unchanged image bytes");
  return directory;
}

const draft = { guidance: "Keep the selected inner layer recognizable at its natural neckline.", reason: "A user preferred the corrected neckline visibility in the same outfit.", sourceVersionIds: ["v1", "v2"], sourceEventIds: ["e1", "e2"] };

test("calibration versions supplement defaults, persist, and reset without deleting evidence", async (t) => {
  const directory = await fixture(t);
  const originalHistory = await readFile(path.join(directory, "photo-history", "index.json"));
  const defaults = await getPromptCalibration(directory);
  assert.equal(defaults.activeRevisionId, "default");
  assert.equal(defaults.guidance, "");
  const applied = await applyPromptCalibration(directory, draft);
  assert.notEqual(applied.activeRevisionId, "default");
  assert.equal(applied.guidance, draft.guidance);
  assert.deepEqual(applied.revisions[0].sourceVersionIds, ["v1", "v2"]);
  assert.equal((await getPromptCalibration(directory)).activeRevisionId, applied.activeRevisionId);
  const reset = await resetPromptCalibration(directory);
  assert.equal(reset.isDefault, true);
  assert.equal(reset.guidance, "");
  assert.equal(reset.revisions.length, 1);
  assert.equal(reset.events.at(-1).type, "reset");
  assert.equal(reset.events.at(-1).fromRevisionId, applied.activeRevisionId);
  assert.deepEqual(await readFile(path.join(directory, "photo-history", "index.json")), originalHistory);
  assert.equal(await readFile(path.join(directory, "photo-history", "v1.png"), "utf8"), "unchanged image bytes");
  assert.equal((await resetPromptCalibration(directory)).events.length, 2);
});

test("calibration evidence distinguishes explicit feedback from weaker regeneration and undo signals", async (t) => {
  const directory = await fixture(t);
  const evidence = await exportPromptCalibrationEvidence(directory);
  const target = evidence.targets[0];
  assert.equal(target.versions.length, 3);
  assert.equal(target.versions[0].prompt, "Full original prompt");
  assert.equal(target.versions[0].localImage, path.join(directory, "photo-history", "assets", "v1.png"));
  assert.deepEqual(target.versions[1].context.garmentIds, ["top", "bottom"]);
  assert.deepEqual(target.signals.map(({ source, polarity, weight }) => ({ source, polarity, weight })), [
    { source: "explicit-feedback", polarity: "negative", weight: 1 },
    { source: "explicit-feedback", polarity: "positive", weight: 1 },
    { source: "regenerated-predecessor", polarity: "negative", weight: 0.35 },
    { source: "undone-generation", polarity: "negative", weight: 0.35 },
  ]);
  assert.equal(target.events.length, 3);
  assert.equal((await getPromptCalibration(directory)).isDefault, true);
});

test("calibration rejects ungrounded references and invalid drafts without writing a revision", async (t) => {
  const directory = await fixture(t);
  for (const invalid of [
    { ...draft, sourceVersionIds: [] },
    { ...draft, sourceVersionIds: ["nonexistent"] },
    { ...draft, sourceEventIds: ["nonexistent"] },
    { ...draft, guidance: " " },
    { ...draft, guidance: "x".repeat(6001) },
    { ...draft, reason: "" },
    { ...draft, reason: "x".repeat(2001) },
  ]) await assert.rejects(applyPromptCalibration(directory, invalid), { status: 400 });
  assert.deepEqual((await getPromptCalibration(directory)).revisions, []);
  assert.equal((await readdir(directory)).includes("prompt-calibration.json"), false);
  assert.equal((await readdir(directory)).includes(".library.lock"), false);
});

test("simultaneous calibration writes retain every revision under the shared wardrobe lock", async (t) => {
  const directory = await fixture(t);
  const results = await Promise.all([
    applyPromptCalibration(directory, draft),
    applyPromptCalibration(directory, { ...draft, guidance: "Prefer a relaxed pose with each selected piece readable." }),
    applyPromptCalibration(directory, { ...draft, guidance: "Keep warm natural lighting when both examples show the same clothes." }),
  ]);
  const state = await getPromptCalibration(directory);
  assert.equal(state.revisions.length, 3);
  assert.equal(new Set(state.revisions.map(({ id }) => id)).size, 3);
  assert.equal(state.events.length, 3);
  assert.ok(results.every((result) => state.revisions.some(({ id }) => id === result.activeRevisionId)));
  assert.ok(state.revisions.some(({ id }) => id === state.activeRevisionId));
});

test("calibration CLI exports once, applies a grounded draft, and restores defaults", async (t) => {
  const directory = await fixture(t);
  const evidenceFile = path.join(directory, "evidence.json");
  const draftFile = path.join(directory, "draft.json");
  const run = (...args) => spawnSync(process.execPath, [cli, "--data", directory, ...args], { encoding: "utf8" });
  assert.equal(run("--export", evidenceFile).status, 0);
  assert.equal(JSON.parse(await readFile(evidenceFile, "utf8")).targets.length, 1);
  assert.notEqual(run("--export", evidenceFile).status, 0);
  await writeFile(draftFile, JSON.stringify(draft));
  const apply = run("--apply", draftFile);
  assert.equal(apply.status, 0, apply.stderr);
  assert.equal(JSON.parse(apply.stdout).isDefault, false);
  assert.equal(JSON.parse(run("--reset").stdout).isDefault, true);
  assert.equal(JSON.parse(run("--show").stdout).revisions.length, 1);
  assert.notEqual(run("--apply").status, 0);
});
