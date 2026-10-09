import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { resolveWardrobeDataDir } from "./wardrobe-paths.mjs";

const importer = fileURLToPath(new URL("../.agents/skills/import-clothes/scripts/import-to-wardrobe.mjs", import.meta.url));
const archiveCli = fileURLToPath(new URL("./archive-modeled-photos.mjs", import.meta.url));

async function fixture(t) {
  const repo = await mkdtemp(path.join(tmpdir(), "wardrobe-configured-data-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await writeFile(path.join(repo, ".env"), "WARDROBE_DATA_DIR=configured/wardrobe\n");
  await writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "wardrobe" }));
  return repo;
}

test("wardrobe directory uses explicit, process, development config and repository fallback in order", async (t) => {
  const repo = await fixture(t);
  await writeFile(path.join(repo, ".env.development"), "WARDROBE_DATA_DIR=development/wardrobe\n");
  const saved = process.env.WARDROBE_DATA_DIR;
  try {
    delete process.env.WARDROBE_DATA_DIR;
    assert.equal(resolveWardrobeDataDir(repo), path.join(repo, "development", "wardrobe"));
    process.env.WARDROBE_DATA_DIR = "process/wardrobe";
    assert.equal(resolveWardrobeDataDir(repo), path.join(repo, "process", "wardrobe"));
    assert.equal(resolveWardrobeDataDir(repo, "explicit/wardrobe"), path.join(repo, "explicit", "wardrobe"));
    const absolute = path.join(repo, "absolute-wardrobe");
    assert.equal(resolveWardrobeDataDir(repo, absolute), absolute);
    delete process.env.WARDROBE_DATA_DIR;
    await rm(path.join(repo, ".env"));
    await rm(path.join(repo, ".env.development"));
    assert.equal(resolveWardrobeDataDir(repo), path.join(repo, "data"));
  } finally {
    if (saved === undefined) delete process.env.WARDROBE_DATA_DIR;
    else process.env.WARDROBE_DATA_DIR = saved;
  }
});

test("agent import and archival share configured data and leave the default wardrobe untouched", async (t) => {
  const repo = await fixture(t);
  const dataDir = path.join(repo, "configured", "wardrobe");
  const oldData = path.join(repo, "data");
  await mkdir(oldData);
  const originalLibrary = '[{"id":"default-wardrobe-sentinel","name":"Untouched"}]\n';
  await writeFile(path.join(oldData, "library.json"), originalLibrary);
  const items = path.join(repo, "items");
  const modeled = path.join(repo, "modeled");
  await mkdir(items);
  await mkdir(modeled);
  const garment = await sharp({ create: { width: 48, height: 64, channels: 4, background: "#00000000" } })
    .composite([{ input: await sharp({ create: { width: 32, height: 50, channels: 4, background: "#557788" } }).png().toBuffer(), left: 8, top: 7 }]).png().toBuffer();
  await writeFile(path.join(items, "navy-top.png"), garment);
  await sharp({ create: { width: 96, height: 64, channels: 3, background: "#8899aa" } }).png().toFile(path.join(modeled, "preview.png"));
  const importManifest = path.join(repo, "import.json");
  await writeFile(importManifest, JSON.stringify({ items: [{ slug: "navy-top", name: "Navy Top", file: "navy-top.png", part: "upperbody", color: "#557788", status: "accepted", canLayer: false, modeledFiles: [{ mode: "default", file: "preview.png", prompt: "Exact initial preview prompt" }] }] }));
  const childEnv = { ...process.env };
  delete childEnv.WARDROBE_DATA_DIR;
  const run = (script, args, cwd = repo) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd, env: childEnv, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  // --repo, rather than the calling directory, selects the importer's config.
  const imported = run(importer, ["--repo", repo, "--items", items, "--modeled", modeled, "--manifest", importManifest], items);
  assert.equal(imported.library, path.join(dataDir, "library.json"));
  assert.equal(imported.total, 1);
  const archiveManifest = path.join(repo, "archive.json");
  await writeFile(archiveManifest, JSON.stringify({ photos: [{ kind: "outfit", targetId: "navy-denim", mode: "default", file: "modeled/preview.png", status: "accepted", activate: true, prompt: "Exact outfit prompt", context: { garmentIds: [imported.items[0].id] } }] }));
  const archived = run(archiveCli, ["--manifest", archiveManifest]);
  const history = JSON.parse(await readFile(path.join(dataDir, "photo-history", "index.json"), "utf8"));
  assert.equal(history.targets.length, 2);
  const preview = history.targets.find((target) => target.kind === "item");
  assert.equal(preview.versions[0].prompt, "Exact initial preview prompt");
  assert.ok(await readFile(path.join(dataDir, "photo-history", "assets", `${preview.versions[0].sha256}.png`)));
  const outfit = history.targets.find((target) => target.kind === "outfit");
  assert.equal(outfit.activeVersionId, archived.photos[0].id);
  // Explicit --data keeps its cwd-relative meaning and takes priority.
  run(archiveCli, ["--data", "../override", "--manifest", archiveManifest], items);
  assert.equal(JSON.parse(await readFile(path.join(repo, "override", "photo-history", "index.json"), "utf8")).targets.length, 1);
  assert.equal(await readFile(path.join(oldData, "library.json"), "utf8"), originalLibrary);
  assert.deepEqual(await readdir(oldData), ["library.json"]);
});
