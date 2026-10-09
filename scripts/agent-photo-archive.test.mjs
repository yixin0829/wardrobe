import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import sharp from "sharp";

const archiveCli = fileURLToPath(new URL("./archive-modeled-photos.mjs", import.meta.url));
const importer = fileURLToPath(new URL("../.agents/skills/import-clothes/scripts/import-to-wardrobe.mjs", import.meta.url));

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "wardrobe-agent-archive-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "data"));
  await mkdir(path.join(directory, "items"));
  await mkdir(path.join(directory, "modeled"));
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "wardrobe" }));
  const garment = await sharp({ create: { width: 48, height: 64, channels: 4, background: "#00000000" } }).composite([{ input: await sharp({ create: { width: 32, height: 50, channels: 4, background: "#557788" } }).png().toBuffer(), left: 8, top: 7 }]).png().toBuffer();
  await writeFile(path.join(directory, "items", "navy-shirt.png"), garment);
  for (const [file, background] of [["default.png", "#8899aa"], ["new-default.png", "#aabbcc"], ["layer.png", "#ccddee"], ["rejected.png", "#bb4466"]]) {
    await sharp({ create: { width: 96, height: 64, channels: 3, background } }).png().toFile(path.join(directory, "modeled", file));
  }
  return directory;
}

test("agent importer archives replaced previews with exact prompts and never writes history on a dry run", async (t) => {
  const directory = await fixture(t);
  const manifestFile = path.join(directory, "manifest.json");
  const item = { slug: "navy-shirt", file: "navy-shirt.png", name: "Navy Shirt", part: "upperbody", color: "#557788", secondaryColor: null, tags: [], status: "accepted", canLayer: false, layeringSource: "ai" };
  const writeManifest = (changes) => writeFile(manifestFile, JSON.stringify({ items: [{ ...item, ...changes }] }));
  const run = (...args) => spawnSync(process.execPath, [importer, "--repo", directory, "--items", path.join(directory, "items"), "--modeled", path.join(directory, "modeled"), "--manifest", manifestFile, ...args], { encoding: "utf8" });
  await writeManifest({ modeledFiles: [{ mode: "default", file: "default.png", prompt: "First exact prompt", context: { modelDirection: "User direction" } }] });
  const dry = run("--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  await assert.rejects(readFile(path.join(directory, "data", "photo-history", "index.json")), { code: "ENOENT" });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const libraryFile = path.join(directory, "data", "library.json");
  const previous = JSON.parse(await readFile(libraryFile, "utf8"))[0];
  assert.match(previous.modeledImage, /^\/api\/import\/photo-history\/[a-f0-9]{64}\.png$/);
  await writeManifest({ canLayer: true, modeledFiles: [
    { mode: "default", file: "new-default.png", prompt: "New default exact prompt" },
    { mode: "layer", file: "layer.png", prompt: "Exact layered prompt", context: { innerLayer: "hoodie" } },
  ] });
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  const records = JSON.parse(await readFile(libraryFile, "utf8"));
  assert.equal(records.length, 1);
  assert.equal(records[0].id, previous.id);
  assert.equal(records[0].modeledImages.length, 2);
  const history = JSON.parse(await readFile(path.join(directory, "data", "photo-history", "index.json"), "utf8"));
  const normal = history.targets.find(({ mode }) => mode === "default");
  const layered = history.targets.find(({ mode }) => mode === "layer");
  assert.equal(normal.versions.length, 2);
  assert.equal(normal.versions[0].image, previous.modeledImage);
  assert.equal(normal.versions[0].prompt, "First exact prompt");
  assert.equal(normal.versions[0].context.modelDirection, "User direction");
  assert.equal(layered.versions[0].prompt, "Exact layered prompt");
  assert.equal(layered.versions[0].context.innerLayer, "hoodie");
  const before = await readFile(path.join(directory, "data", "photo-history", "index.json"));
  await writeManifest({ canLayer: true });
  assert.equal(run().status, 0);
  assert.deepEqual(JSON.parse(await readFile(libraryFile, "utf8"))[0].modeledImages, records[0].modeledImages);
  const after = JSON.parse(await readFile(path.join(directory, "data", "photo-history", "index.json"), "utf8"));
  assert.equal(after.targets.flatMap(({ versions }) => versions).length, JSON.parse(before).targets.flatMap(({ versions }) => versions).length);
});

test("agent archive CLI retains rejected attempts and a replaced lookbook image for comparison", async (t) => {
  const directory = await fixture(t);
  const dataDir = path.join(directory, "data");
  await mkdir(path.join(dataDir, "outfit-images"));
  const original = await readFile(path.join(directory, "modeled", "default.png"));
  await writeFile(path.join(dataDir, "outfit-images", "navy-denim.png"), original);
  await writeFile(path.join(dataDir, "outfits.json"), JSON.stringify({ version: 1, outfits: [{ id: "navy-denim", name: "Navy Denim", image: "outfit-images/navy-denim.png", garmentIds: ["shirt", "jeans"] }] }));
  const manifestFile = path.join(directory, "archive.json");
  await writeFile(manifestFile, JSON.stringify({ photos: [
    { kind: "outfit", targetId: "navy-denim", mode: "default", file: "modeled/rejected.png", status: "rejected", activate: false, prompt: "Bad generated prompt", context: { qa: "Garment changed" } },
    { kind: "outfit", targetId: "navy-denim", mode: "default", file: "modeled/layer.png", status: "accepted", activate: true, prompt: "Corrected prompt", context: { garmentIds: ["shirt", "jeans"] } },
  ] }));
  const run = () => spawnSync(process.execPath, [archiveCli, "--data", dataDir, "--manifest", manifestFile], { encoding: "utf8" });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const archived = JSON.parse(result.stdout);
  assert.equal(archived.archived, 2);
  const history = JSON.parse(await readFile(path.join(dataDir, "photo-history", "index.json"), "utf8"));
  const target = history.targets[0];
  assert.equal(target.versions.length, 3);
  assert.equal(target.versions[0].source, "legacy");
  assert.equal(target.versions[0].prompt, null);
  assert.equal(target.versions[1].status, "rejected");
  assert.equal(target.versions[1].context.qa, "Garment changed");
  assert.equal(target.activeVersionId, archived.photos[1].id);
  assert.deepEqual(await readFile(path.join(dataDir, "outfit-images", "navy-denim.png")), original);
  await writeFile(manifestFile, JSON.stringify({ photos: [{ kind: "outfit", targetId: "navy-denim", mode: "default", file: "modeled/rejected.png", status: "rejected", activate: true, prompt: "Prompt", context: {} }] }));
  assert.notEqual(run().status, 0);
  assert.equal(JSON.parse(await readFile(path.join(dataDir, "photo-history", "index.json"), "utf8")).targets[0].versions.length, 3);
});
