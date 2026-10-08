#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";
import { getExpectedModeledModes, getModeledImages, normalizeLayering } from "../../../../src/wardrobe-model.js";
import { withLibraryLock } from "../../../../scripts/library-store.mjs";

const PARTS = new Set(["upperbody", "wholebody_up", "lowerbody", "accessories_up", "shoes"]);
const HEX = /^#[0-9a-f]{6}$/i;
const MODES = new Set(["top", "layer", "default"]);

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error("Usage: import-to-wardrobe.mjs --items <directory> --manifest <file> [--modeled <directory>] [--repo <directory>] [--dry-run]");
  process.exit(message ? 1 : 0);
}

function parseArgs(argv) {
  const options = { repo: process.cwd(), dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") usage();
    if (argument === "--dry-run") { options.dryRun = true; continue; }
    if (!["--items", "--manifest", "--modeled", "--repo"].includes(argument)) usage(`Unknown option: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usage(`${argument} requires a value`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  if (!options.items) usage("--items is required");
  if (!options.manifest) usage("--manifest is required");
  return options;
}

function safeSlug(value) {
  if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new Error(`Invalid slug: ${value}`);
  return value;
}

function stableUuid(hash) {
  const raw = hash.slice(0, 32).split("");
  raw[12] = "4";
  raw[16] = ((Number.parseInt(raw[16], 16) & 0x3) | 0x8).toString(16);
  const value = raw.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function localPng(value, slug, field) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]*\.png$/i.test(value)) {
    throw new Error(`${slug}: ${field} must be a local PNG filename without a path`);
  }
  return value;
}

function normalizeItem(item) {
  if (!item || item.status !== "accepted") return null;
  const slug = safeSlug(item.slug);
  if (!PARTS.has(item.part)) throw new Error(`${slug}: invalid part ${item.part}`);
  if (!HEX.test(item.color)) throw new Error(`${slug}: color must be a six-digit hex value`);
  if (item.secondaryColor !== null && item.secondaryColor !== undefined && !HEX.test(item.secondaryColor)) throw new Error(`${slug}: secondaryColor must be null or a six-digit hex value`);
  const tags = Array.isArray(item.tags)
    ? item.tags.filter((tag) => typeof tag === "string").map((tag) => tag.trim().toLowerCase()).filter(Boolean).slice(0, 12)
    : [];
  const classified = Object.hasOwn(item, "isShirt") || Object.hasOwn(item, "canLayer");
  if (classified && (typeof item.isShirt !== "boolean" || typeof item.canLayer !== "boolean")) {
    throw new Error(`${slug}: isShirt and canLayer must both be booleans`);
  }
  if (classified && ((item.isShirt && item.part !== "upperbody") || (item.canLayer && !item.isShirt))) {
    throw new Error(`${slug}: only a shirt in Tops can wear as a layer`);
  }
  if (item.layeringSource !== undefined && !["ai", "manual"].includes(item.layeringSource)) {
    throw new Error(`${slug}: layeringSource must be ai or manual`);
  }
  let modeledFiles = [];
  if (item.modeledFiles !== undefined) {
    if (!Array.isArray(item.modeledFiles)) throw new Error(`${slug}: modeledFiles must be an array`);
    const modes = new Set();
    modeledFiles = item.modeledFiles.map((entry) => {
      if (!entry || !MODES.has(entry.mode) || modes.has(entry.mode)) throw new Error(`${slug}: modeledFiles must have unique valid modes`);
      modes.add(entry.mode);
      return { mode: entry.mode, file: localPng(entry.file, slug, "modeledFiles.file") };
    });
  } else if (item.modeledFile) {
    modeledFiles = [{ mode: null, file: localPng(item.modeledFile, slug, "modeledFile") }];
  }
  return {
    slug,
    file: localPng(item.file || `${slug}.png`, slug, "file"),
    modeledFiles,
    modeledFilesPresent: item.modeledFiles !== undefined,
    classified,
    ...(classified ? { isShirt: item.isShirt, canLayer: item.canLayer, layeringSource: item.layeringSource || "ai" } : {}),
    name: typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, 120) : slug.split("-").map((word) => word[0].toUpperCase() + word.slice(1)).join(" "),
    part: item.part,
    color: item.color.toLowerCase(),
    secondaryColor: item.secondaryColor?.toLowerCase() || null,
    tags,
  };
}

async function validatePng(file, slug) {
  const bytes = await readFile(file);
  const image = sharp(bytes);
  const metadata = await image.metadata();
  if (metadata.format !== "png") throw new Error(`${slug}: ${path.basename(file)} is not a PNG`);
  if (!metadata.hasAlpha) throw new Error(`${slug}: PNG has no alpha channel`);
  const stats = await image.stats();
  const alpha = stats.channels[3];
  if (!alpha || alpha.min !== 0 || alpha.max === 0) throw new Error(`${slug}: PNG must contain transparent and visible pixels`);
  return { bytes, hash: createHash("sha256").update(bytes).digest("hex") };
}

async function validateModeledPng(file, slug) {
  const bytes = await readFile(file);
  const metadata = await sharp(bytes).metadata();
  if (metadata.format !== "png") throw new Error(`${slug}: ${path.basename(file)} is not a PNG`);
  if (!metadata.width || !metadata.height) throw new Error(`${slug}: modeled PNG has invalid dimensions`);
  return { bytes, hash: createHash("sha256").update(bytes).digest("hex") };
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

async function writeAsset(file, bytes) {
  try { await writeFile(file, bytes, { flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!(await readFile(file)).equals(bytes)) throw new Error(`Asset content conflicts with ${path.basename(file)}`);
  }
}

function previewModes(item, layering, existing) {
  const modes = item.modeledFiles.map(({ mode }) => mode || (layering.isShirt ? "top" : "default"));
  if (modes.length && (item.classified || item.modeledFilesPresent || existing?.isShirt !== undefined)) {
    const expected = getExpectedModeledModes({ ...item, ...layering });
    if (modes.length !== expected.length || expected.some((mode) => !modes.includes(mode))) {
      throw new Error(`${item.slug}: modeled photos must have exactly ${expected.join(" and ")} modes; check saved manual choices before generation`);
    }
  }
  return modes;
}

const options = parseArgs(process.argv.slice(2));
const repo = path.resolve(options.repo);
const itemsDir = path.resolve(options.items);
const modeledDir = options.modeled ? path.resolve(options.modeled) : null;
const manifestFile = path.resolve(options.manifest);
const packageFile = path.join(repo, "package.json");
const packageJson = await readJson(packageFile, null);
if (!packageJson || packageJson.name !== "wardrobe") throw new Error(`Not a Wardrobe repository: ${repo}`);

const manifest = await readJson(manifestFile, null);
if (!manifest || !Array.isArray(manifest.items)) throw new Error("Manifest must contain an items array");
const accepted = manifest.items.map(normalizeItem).filter(Boolean);
if (!accepted.length) throw new Error("Manifest contains no accepted items");
if (new Set(accepted.map(({ slug }) => slug)).size !== accepted.length) throw new Error("Accepted item slugs must be unique");

const prepared = [];
for (const item of accepted) {
  const source = path.resolve(itemsDir, item.file);
  if (path.dirname(source) !== itemsDir) throw new Error(`${item.slug}: file must be directly inside the items directory`);
  if (!(await stat(source)).isFile()) throw new Error(`${item.slug}: source is not a file`);
  const { bytes, hash } = await validatePng(source, item.slug);
  const uuid = stableUuid(hash);
  const id = `import-${uuid}`;
  const assetName = `${id}-garment.png`;
  const models = [];
  for (const model of item.modeledFiles) {
    if (!modeledDir) throw new Error(`${item.slug}: --modeled is required when modeled files are set`);
    const modeledSource = path.resolve(modeledDir, model.file);
    if (path.dirname(modeledSource) !== modeledDir) throw new Error(`${item.slug}: modeledFile must be directly inside the modeled directory`);
    if (!(await stat(modeledSource)).isFile()) throw new Error(`${item.slug}: modeled source is not a file`);
    const modeled = await validateModeledPng(modeledSource, item.slug);
    models.push({ ...model, ...modeled });
  }
  prepared.push({ ...item, bytes, uuid, id, assetName, models });
}
if (new Set(prepared.map(({ id }) => id)).size !== prepared.length) throw new Error("Accepted items contain duplicate garment cutouts; consolidate physical items in the manifest");

const dataDir = path.join(repo, "data");
const importedDir = path.join(dataDir, "imported");
const libraryFile = path.join(dataDir, "library.json");
async function importRecords() {
  const records = await readJson(libraryFile, []);
  if (!Array.isArray(records)) throw new Error(`${libraryFile} must contain a JSON array`);

  const nextRecords = [...records];
  for (const item of prepared) {
    const assetUrl = `/api/import/library/${item.assetName}`;
    const existingIndex = nextRecords.findIndex((entry) => entry.id === item.id);
    const existing = existingIndex === -1 ? null : nextRecords[existingIndex];
    const layering = normalizeLayering(item, existing || {});
    const modes = previewModes(item, layering, existing);
    item.models = item.models.map((model, index) => ({
      ...model,
      mode: modes[index],
      assetName: `${item.id}-modeled-${modes[index]}-${model.hash}.png`,
    }));
    const modeledImages = item.models.length ? item.models.map((model) => ({
      id: `${item.id}-${model.mode}`,
      mode: model.mode,
      image: `/api/import/library/${model.assetName}`,
    })).sort((first, second) => (first.mode === "layer") - (second.mode === "layer")) : getModeledImages(existing || {});
    const record = {
      id: item.id,
      name: item.name,
      part: item.part,
      color: item.color,
      secondaryColor: item.secondaryColor,
      palette: [item.color, item.secondaryColor].filter(Boolean),
      tags: item.tags,
      image: assetUrl,
      thumbnail: assetUrl,
      ...layering,
      modeledImages,
      modeledImage: modeledImages[0]?.image || null,
      ...(item.models.length ? { modeledLayering: { ...layering } } : {}),
      importJobId: item.uuid,
    };
    if (existingIndex === -1) nextRecords.push(record);
    else nextRecords[existingIndex] = { ...nextRecords[existingIndex], ...record };
  }

  if (!options.dryRun) {
    await mkdir(importedDir, { recursive: true });
    for (const item of prepared) {
      await writeAsset(path.join(importedDir, item.assetName), item.bytes);
      for (const model of item.models) await writeAsset(path.join(importedDir, model.assetName), model.bytes);
    }
    await atomicJson(libraryFile, nextRecords);
  }
  return nextRecords;
}

// Re-read manual choices while holding the same cross-process lock as the UI.
const nextRecords = await withLibraryLock(libraryFile, importRecords);

console.log(JSON.stringify({
  dryRun: options.dryRun,
  imported: prepared.length,
  total: nextRecords.length,
  library: libraryFile,
  items: prepared.map(({ id, name, part, assetName, models }) => ({ id, name, part, assetName, modeledAssetNames: models.map((model) => model.assetName) })),
}, null, 2));
