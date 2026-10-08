import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { wardrobeImportApi } from "./import-job-api.mjs";
import { getModeledImages } from "../src/wardrobe-model.js";
import { withLibraryLock } from "./library-store.mjs";

const item = (changes = {}) => ({
  name: "Blue Flannel Shirt", part: "upperbody", color: "#34485c", secondaryColor: null,
  tags: ["flannel", "buttons"], canLayer: true,
  boundingBox: { x: 50, y: 50, width: 900, height: 900 }, ...changes,
});

async function png(width = 96, height = 64, color = "#867766") {
  return sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer();
}

async function deadline(promise, message, milliseconds = 6000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

function respond(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

// Exercise the actual JSON/multipart HTTP protocol without a live provider or .env.
async function fixture(t, detected = [item()], seed = []) {
  const directory = await mkdtemp(path.join(tmpdir(), "wardrobe-layer-tests-"));
  const dataDir = path.join(directory, "data");
  await mkdir(dataDir);
  const source = await png(80, 100);
  await writeFile(path.join(dataDir, "model-reference.png"), source);
  await writeFile(path.join(dataDir, "library.json"), JSON.stringify(seed));
  const state = { analysis: [], edits: [], failMode: null, undecodableMode: null, providerErrors: [], modelGate: null };
  const provider = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, "Bearer wardrobe-test-only");
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      if (req.url === "/v1/responses") {
        const request = JSON.parse(bytes.toString());
        state.analysis.push(request);
        return respond(res, 200, { output_text: JSON.stringify({ items: detected }) });
      }
      assert.equal(req.url, "/v1/images/edits");
      const form = await new Response(bytes, { headers: { "Content-Type": req.headers["content-type"] } }).formData();
      const prompt = form.get("prompt");
      const files = await Promise.all(form.getAll("image[]").map(async (file) => {
        const content = Buffer.from(await file.arrayBuffer());
        assert.equal((await sharp(content).metadata()).format, "png");
        return { name: file.name, type: file.type, bytes: content };
      }));
      const mode = form.get("size") === "1024x1024" ? "garment" : /Use the featured garment as an OUTER LAYER/i.test(prompt) ? "layer" : "default";
      state.edits.push({ prompt, files, mode, size: form.get("size") });
      if (state.modelGate && mode === state.modelGate.mode) {
        state.modelGate.started();
        await state.modelGate.wait;
      }
      if (mode === state.failMode) return respond(res, 503, { error: { message: "Fixture layer generation failed" } });
      let output;
      if (mode === "garment") {
        const key = prompt.match(/uniform solid (#[a-f0-9]{6}) chroma-key/i)?.[1];
        assert.ok(key, "garment prompt must identify its exact chroma key");
        output = await sharp({ create: { width: 80, height: 100, channels: 4, background: key } })
          .composite([{ input: await png(40, 60, "#666666"), left: 20, top: 20 }]).png().toBuffer();
      } else {
        // Unique content lets the test verify cache-safe content-versioned URLs.
        output = await png(96, 64, { r: 90 + state.edits.length, g: 110, b: 120, alpha: 1 });
      }
      if (mode === state.undecodableMode) output = Buffer.from("Returned modeled output that cannot be decoded as an image");
      state.edits.at(-1).output = output;
      return respond(res, 200, { data: [{ b64_json: output.toString("base64") }] });
    } catch (error) {
      state.providerErrors.push(error);
      return respond(res, 500, { error: { message: error.message } });
    }
  });
  const providerUrl = await listen(provider);
  const servers = [];
  const env = {
    OPENAI_API_KEY: "wardrobe-test-only", OPENAI_API_BASE_URL: `${providerUrl}/v1`,
    WARDROBE_DATA_DIR: "data", WARDROBE_MODEL_REFERENCE: "data/model-reference.png",
    WARDROBE_MODEL_DIRECTION: "Natural fixture proportions",
  };
  async function newApi() {
    const plugin = wardrobeImportApi({ env });
    await plugin.configResolved({ root: directory });
    let handler;
    plugin.configureServer({ middlewares: { use(value) { handler = value; } } });
    const server = createServer((req, res) => {
      void handler(req, res, () => { res.statusCode = 404; res.end(); });
    });
    const url = await listen(server);
    servers.push(server);
    return url;
  }
  const url = await newApi();
  t.after(async () => {
    state.modelGate?.release();
    await Promise.all(servers.map(close));
    await close(provider);
    // The only recursive removal is the exact private mkdtemp fixture root.
    const absolute = path.resolve(directory);
    assert.equal(path.dirname(absolute), path.resolve(tmpdir()));
    assert.ok(path.basename(absolute).startsWith("wardrobe-layer-tests-"));
    await rm(absolute, { recursive: true, force: true });
    assert.deepEqual(state.providerErrors, [], "the fake provider must receive valid requests");
  });
  async function request(route, method = "GET", value, base = url) {
    const response = await fetch(`${base}${route}`, {
      method,
      ...(value === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }),
    });
    return { status: response.status, value: await response.json() };
  }
  async function upload() {
    const result = await request("/api/import/jobs", "POST", { imageDataUrl: `data:image/png;base64,${source.toString("base64")}` });
    assert.equal(result.status, 202);
    return result.value.jobs;
  }
  async function waitFor(id, stage, status) {
    const deadline = Date.now() + 6000;
    let last;
    while (Date.now() < deadline) {
      const result = await request(`/api/import/jobs/${id}`);
      assert.equal(result.status, 200);
      last = result.value;
      if (last.stages[stage].status === status) return last;
      if (last.stages[stage].status === "failed" && status !== "failed") assert.fail(last.stages[stage].error);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    assert.fail(`Timed out waiting for ${stage}/${status}: ${JSON.stringify(last?.stages[stage])}`);
  }
  async function garmentReview(job) {
    const crop = await request(`/api/import/jobs/${job.id}/stages/crop/approve`, "POST", {});
    assert.equal(crop.status, 200);
    return waitFor(job.id, "garment", "review");
  }
  async function modeledReview(job, target = "review") {
    await garmentReview(job);
    const garment = await request(`/api/import/jobs/${job.id}/stages/garment/approve`, "POST", {});
    assert.equal(garment.status, 200);
    return waitFor(job.id, "modeled", target);
  }
  async function approveModeled(job) {
    return request(`/api/import/jobs/${job.id}/stages/modeled/approve`, "POST", {
      reviewedImageIds: job.stages.modeled.images.map((image) => image.id),
    });
  }
  async function library() { return (await request("/api/import/wardrobe")).value; }
  return { directory, dataDir, state, url, newApi, request, upload, waitFor, garmentReview, modeledReview, approveModeled, library };
}

test("AI layer eligibility leads to exactly two reviewed looks and one persistent wardrobe item", async (t) => {
  const f = await fixture(t);
  const [job] = await f.upload();
  assert.equal(Object.hasOwn(job.metadata, "isShirt"), false);
  assert.equal(job.metadata.canLayer, true);
  assert.equal(job.metadata.layeringSource, "ai");
  assert.equal(job.metadata.part, "upperbody");
  assert.equal(f.state.edits.length, 0, "nothing generates before crop approval");
  const schema = f.state.analysis[0].text.format.schema.properties.items.items;
  assert.equal(schema.properties.canLayer.type, "boolean");
  assert.ok(schema.required.includes("canLayer"));
  assert.equal(Object.hasOwn(schema.properties, "isShirt"), false);
  assert.equal(schema.required.includes("isShirt"), false);
  const analysisPrompt = f.state.analysis[0].input[0].content[0].text;
  assert.match(analysisPrompt, /flannel/i);
  assert.match(analysisPrompt, /dress shirt.*false/i);
  assert.match(analysisPrompt, /uncertain.*false/i);
  assert.match(analysisPrompt, /jacket/i);
  assert.match(analysisPrompt, /zip/i);
  const review = await f.modeledReview(job);
  assert.deepEqual(f.state.edits.map((edit) => edit.mode), ["garment", "default", "layer"]);
  assert.deepEqual(review.stages.modeled.images.map((image) => image.mode), ["default", "layer"]);
  const [top, layer] = f.state.edits.filter((edit) => edit.mode !== "garment");
  assert.equal(top.files.length, 2, "face and exact featured garment are sent");
  assert.deepEqual(top.files.map((file) => file.name), ["face-reference.png", "garment.png"]);
  assert.match(top.prompt, /closed|standalone|standard|single/i);
  assert.match(layer.prompt, /outer layer/i);
  assert.match(layer.prompt, /T-shirt/i);
  assert.match(layer.prompt, /hoodie/i);
  assert.match(layer.prompt, /experienced.*menswear|menswear.*experienced/i);
  assert.deepEqual(layer.files[1].bytes, top.files[1].bytes, "both looks use the identical cutout");

  for (const reviewedImageIds of [undefined, [review.stages.modeled.images[0].id]]) {
    const rejected = await f.request(`/api/import/jobs/${job.id}/stages/modeled/approve`, "POST", { reviewedImageIds });
    assert.equal(rejected.status, 409);
    assert.match(rejected.value.error, /both modeled photos/i);
  }
  const patch = await f.request(`/api/import/wardrobe/import-${job.id}`, "PATCH", { name: "My Flannel", tags: ["favorite"] });
  assert.equal(patch.status, 200);
  assert.equal(patch.value.layeringSource, "ai");
  assert.equal((await f.approveModeled(review)).status, 200);
  const records = await f.library();
  assert.equal(records.length, 1);
  const [record] = records;
  assert.equal(record.id, `import-${job.id}`);
  assert.equal(record.name, "My Flannel", "late modeled approval preserves gallery edits");
  assert.deepEqual(record.tags, ["favorite"]);
  assert.equal(record.layeringSource, "ai");
  assert.equal(record.modeledImages.length, 2);
  assert.equal(record.modeledImage, record.modeledImages[0].image);
  assert.equal(record.modeledLayering.canLayer, true);
  for (const image of record.modeledImages) {
    const response = await fetch(`${f.url}${image.image}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /immutable/);
    const bytes = Buffer.from(await response.arrayBuffer());
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 20);
    assert.ok(image.image.endsWith(`-${hash}.png`));
    const dimensions = await sharp(bytes).metadata();
    assert.equal(dimensions.width / dimensions.height, 1.5);
  }
  const thumbnail = await fetch(`${f.url}${record.thumbnail}?thumbnail=1`);
  assert.equal(thumbnail.status, 200);
  const thumbnailMetadata = await sharp(Buffer.from(await thumbnail.arrayBuffer())).metadata();
  assert.equal(thumbnailMetadata.width, 384);
  assert.equal(thumbnailMetadata.height, 512);
  assert.equal(thumbnailMetadata.hasAlpha, true);
  const reloaded = await f.newApi();
  assert.deepEqual((await f.request("/api/import/wardrobe", "GET", undefined, reloaded)).value, records);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.dataDir, "library.json"), "utf8")), records);
});

test("items AI judges unsuitable as an outer layer each generate only one modeled look", async (t) => {
  const f = await fixture(t, [
    item({ name: "Formal Dress Shirt", canLayer: false, tags: ["formal", "buttons"] }),
    item({ name: "Plain Tee", canLayer: false, tags: ["cotton"] }),
  ]);
  const jobs = await f.upload();
  assert.equal(jobs[1].metadata.canLayer, false);
  for (const job of jobs) {
    const before = f.state.edits.length;
    const review = await f.modeledReview(job);
    assert.deepEqual(f.state.edits.slice(before).map((edit) => edit.mode), ["garment", "default"]);
    assert.equal(review.stages.modeled.images.length, 1);
    assert.equal((await f.approveModeled(review)).status, 200);
  }
  assert.deepEqual((await f.library()).map((record) => record.modeledImages.length), [1, 1]);
});

test("layer eligibility applies across the original categories without changing the garment category", async (t) => {
  const f = await fixture(t, [
    item({ name: "Zip Jacket", part: "wholebody_up", tags: ["zip", "lightweight"] }),
    item({ name: "Zip Hoodie", part: "upperbody", tags: ["zip", "hood"] }),
  ]);
  const jobs = await f.upload();
  for (const job of jobs) {
    assert.equal(job.metadata.canLayer, true);
    const review = await f.modeledReview(job);
    assert.deepEqual(review.stages.modeled.images.map((image) => image.mode), ["default", "layer"]);
    assert.equal((await f.approveModeled(review)).status, 200);
  }
  const records = await f.library();
  assert.deepEqual(records.map((record) => record.part), ["wholebody_up", "upperbody"]);
  assert.deepEqual(records.map((record) => record.modeledImages.length), [2, 2]);
  assert.equal((await f.request(`/api/import/wardrobe/${records[0].id}`, "PATCH", { canLayer: false })).status, 200);
  const override = await f.request(`/api/import/wardrobe/${records[0].id}`, "PATCH", { part: "accessories_up", canLayer: true, layeringSource: "manual" });
  assert.equal(override.status, 200);
  assert.equal(override.value.canLayer, true, "the shared property is not gated by a hardcoded category");
  assert.equal(override.value.part, "accessories_up");
  assert.equal(override.value.layeringSource, "manual");
});

test("manual import-stage classification controls the generated set", async (t) => {
  const f = await fixture(t, [item({ canLayer: false })]);
  const [job] = await f.upload();
  const edit = await f.request(`/api/import/jobs/${job.id}/metadata`, "PATCH", { canLayer: true });
  assert.equal(edit.status, 200);
  assert.equal(edit.value.metadata.layeringSource, "manual");
  const review = await f.modeledReview(job);
  assert.deepEqual(review.stages.modeled.images.map((image) => image.mode), ["default", "layer"]);
  assert.equal((await f.approveModeled(review)).status, 200);
  const [record] = await f.library();
  assert.equal(record.canLayer, true);
  assert.equal(record.layeringSource, "manual");
});

test("a second-photo failure cannot publish an incomplete pair, and retry regenerates both", async (t) => {
  const f = await fixture(t);
  f.state.failMode = "layer";
  const [job] = await f.upload();
  const failed = await f.modeledReview(job, "failed");
  assert.match(failed.stages.modeled.error, /Fixture layer generation failed/);
  assert.equal(failed.stages.modeled.assetUrl, null);
  assert.deepEqual(failed.stages.modeled.images, []);
  const [partial] = await f.library();
  assert.deepEqual(partial.modeledImages, []);
  assert.equal(partial.modeledImage, null);
  assert.equal((await f.approveModeled(failed)).status, 409);
  f.state.failMode = null;
  assert.equal((await f.request(`/api/import/jobs/${job.id}/stages/modeled/regenerate`, "POST", {})).status, 202);
  const review = await f.waitFor(job.id, "modeled", "review");
  assert.deepEqual(f.state.edits.filter((edit) => edit.mode !== "garment").map((edit) => edit.mode), ["default", "layer", "default", "layer"]);
  assert.equal((await f.approveModeled(review)).status, 200);
  assert.equal((await f.library())[0].modeledImages.length, 2);
});

test("undecodable modeled import output is retained as invalid without replacing the garment", async (t) => {
  const f = await fixture(t, [item({ canLayer: false })]);
  const [job] = await f.upload();
  await f.garmentReview(job);
  f.state.undecodableMode = "default";
  assert.equal((await f.request(`/api/import/jobs/${job.id}/stages/garment/approve`, "POST", {})).status, 200);
  const failed = await f.waitFor(job.id, "modeled", "failed");
  assert.ok(failed.stages.modeled.error);
  const [record] = await f.library();
  assert.deepEqual(record.modeledImages, [], "an invalid attempt must not become a wardrobe preview");
  const garmentBefore = Buffer.from(await (await fetch(`${f.url}${record.image}`)).arrayBuffer());
  const history = JSON.parse(await readFile(path.join(f.dataDir, "photo-history", "index.json"), "utf8"));
  const target = history.targets.find((entry) => entry.kind === "item" && entry.targetId === record.id && entry.mode === "default");
  assert.ok(target, "every returned modeled attempt has a history target");
  const invalid = target.versions.find((version) => version.status === "invalid");
  assert.ok(invalid, "undecodable provider output is archived rather than discarded");
  assert.equal(invalid.prompt, f.state.edits.find((edit) => edit.mode === "default").prompt.replaceAll("\r\n", "\n"), "multipart transport may normalize line endings, but the full prompt remains recorded");
  const archivedResponse = await fetch(`${f.url}${invalid.image}`);
  assert.equal(archivedResponse.status, 200);
  assert.deepEqual(Buffer.from(await archivedResponse.arrayBuffer()), f.state.edits.find((edit) => edit.mode === "default").output, "history preserves the exact returned invalid bytes");
  f.state.undecodableMode = null;
  assert.equal((await f.request(`/api/import/jobs/${job.id}/stages/modeled/regenerate`, "POST", {})).status, 202);
  const review = await f.waitFor(job.id, "modeled", "review");
  assert.equal((await f.approveModeled(review)).status, 200);
  const [accepted] = await f.library();
  assert.equal(accepted.id, record.id);
  assert.equal(accepted.image, record.image);
  assert.deepEqual(Buffer.from(await (await fetch(`${f.url}${accepted.image}`)).arrayBuffer()), garmentBefore);
  const retained = JSON.parse(await readFile(path.join(f.dataDir, "photo-history", "index.json"), "utf8"));
  assert.ok(retained.targets.flatMap((entry) => entry.versions).some((version) => version.id === invalid.id), "a successful retry keeps the earlier invalid attempt");
});

test("changing layer eligibility makes old photos unapprovable until the correct set is regenerated", async (t) => {
  const f = await fixture(t);
  const [job] = await f.upload();
  const oldReview = await f.modeledReview(job);
  assert.equal((await f.request(`/api/import/wardrobe/import-${job.id}`, "PATCH", { canLayer: false })).status, 200);
  const stale = await f.approveModeled(oldReview);
  assert.equal(stale.status, 409);
  assert.match(stale.value.error, /settings changed.*Regenerate/i);
  assert.equal((await f.library())[0].modeledImages.length, 0);
  assert.equal((await f.request(`/api/import/jobs/${job.id}/stages/modeled/regenerate`, "POST", {})).status, 202);
  const review = await f.waitFor(job.id, "modeled", "review");
  assert.deepEqual(review.stages.modeled.images.map((image) => image.mode), ["default"]);
  assert.equal((await f.approveModeled(review)).status, 200);
  const [record] = await f.library();
  assert.equal(record.canLayer, false);
  assert.equal(record.layeringSource, "manual");
  assert.equal(record.modeledImages.length, 1);
});

test("two API instances serialize library edits without losing unrelated changes", async (t) => {
  const firstId = `import-${randomUUID()}`;
  const secondId = `import-${randomUUID()}`;
  const seed = [
    { ...item(), id: firstId, layeringSource: "ai", modeledImages: [] },
    { ...item({ name: "Second Shirt" }), id: secondId, layeringSource: "ai", modeledImages: [] },
  ];
  const f = await fixture(t, [], seed);
  const otherApi = await f.newApi();
  const results = await Promise.all([
    f.request(`/api/import/wardrobe/${firstId}`, "PATCH", { name: "Edited First", canLayer: false }),
    f.request(`/api/import/wardrobe/${secondId}`, "PATCH", { tags: ["edited", "favorite"] }, otherApi),
  ]);
  assert.deepEqual(results.map((result) => result.status), [200, 200]);
  const records = await f.library();
  assert.equal(records.find((record) => record.id === firstId).name, "Edited First");
  assert.equal(records.find((record) => record.id === firstId).canLayer, false);
  assert.deepEqual(records.find((record) => record.id === secondId).tags, ["edited", "favorite"]);
  assert.equal((await f.request(`/api/import/wardrobe/${firstId}`, "PATCH", { canLayer: "yes" })).status, 400);
});

test("legacy single-photo records still resolve, render a thumbnail, and delete their assets", async (t) => {
  const id = `import-${randomUUID()}`;
  const image = `/api/import/library/${id}-garment.png`;
  const modeledImage = `/api/import/library/${id}-modeled.png`;
  const f = await fixture(t, [], [{ ...item(), id, image, thumbnail: image, modeledImage }]);
  await writeFile(path.join(f.dataDir, "imported", `${id}-garment.png`), await png(80, 100));
  await writeFile(path.join(f.dataDir, "imported", `${id}-modeled.png`), await png());
  const [record] = await f.library();
  assert.deepEqual(getModeledImages(record), [{ id: "modeled-default", mode: "default", image: modeledImage }]);
  assert.equal((await fetch(`${f.url}${image}?thumbnail=1`)).status, 200);
  assert.equal((await fetch(`${f.url}${modeledImage}`)).status, 200);
  assert.equal((await f.request(`/api/import/wardrobe/${id}`, "DELETE")).status, 200);
  assert.deepEqual(await f.library(), []);
  assert.equal((await fetch(`${f.url}${modeledImage}`)).status, 404);
});

test("an abandoned local library lock is recovered before the next write", async (t) => {
  const f = await fixture(t, []);
  const lock = path.join(f.dataDir, ".library.lock");
  // A PID beyond the OS range is guaranteed absent; no live process is touched.
  await writeFile(lock, JSON.stringify({ pid: 2147483647, owner: randomUUID(), hostname: hostname() }));
  const libraryFile = path.join(f.dataDir, "library.json");
  await withLibraryLock(libraryFile, () => writeFile(libraryFile, JSON.stringify([{ id: "recovered" }])));
  assert.deepEqual((await f.library()).map((record) => record.id), ["recovered"]);
  await assert.rejects(readFile(lock), { code: "ENOENT" });
});

test("saving untouched AI classification preserves its source, while a real override survives a stale AI draft", async (t) => {
  const f = await fixture(t);
  const [job] = await f.upload();
  const untouchedDraft = { ...job.metadata, name: "AI Classified Flannel" };
  const fullDraft = await f.request(`/api/import/jobs/${job.id}/metadata`, "PATCH", { metadata: untouchedDraft });
  assert.equal(fullDraft.status, 200);
  assert.equal(fullDraft.value.metadata.layeringSource, "ai", "saving prefilled controls is not a manual classification");
  const review = await f.modeledReview(job);
  const id = `import-${job.id}`;
  const nameOnly = await f.request(`/api/import/wardrobe/${id}`, "PATCH", { name: "Renamed Flannel" });
  assert.equal(nameOnly.status, 200);
  assert.equal(nameOnly.value.layeringSource, "ai", "a gallery name edit leaves AI classification alone");
  const manual = await f.request(`/api/import/wardrobe/${id}`, "PATCH", { canLayer: false, layeringSource: "manual" });
  assert.equal(manual.status, 200);
  assert.equal(manual.value.canLayer, false);
  assert.equal(manual.value.layeringSource, "manual");
  const stale = await f.request(`/api/import/jobs/${job.id}/metadata`, "PATCH", { metadata: untouchedDraft });
  assert.equal(stale.status, 200);
  assert.equal(stale.value.metadata.canLayer, false, "a later stale AI full draft cannot undo the manual toggle");
  assert.equal(stale.value.metadata.layeringSource, "manual");
  assert.equal((await f.approveModeled(review)).status, 409, "old images still need regeneration for the manual mode choice");
  const reloaded = await f.newApi();
  const [saved] = (await f.request("/api/import/wardrobe", "GET", undefined, reloaded)).value;
  assert.equal(saved.canLayer, false);
  assert.equal(saved.layeringSource, "manual");
  const invalidSource = await f.request(`/api/import/wardrobe/${id}`, "PATCH", { layeringSource: "guess" });
  assert.equal(invalidSource.status, 400);
});

test("deleting an imported item cancels pending or reviewable model jobs and prevents resurrection", async (t) => {
  for (const phase of ["pending", "review"]) {
    await t.test(phase, async (subtest) => {
      const f = await fixture(subtest);
      const [job] = await f.upload();
      let review = job;
      let started;
      if (phase === "pending") {
        const wait = new Promise((resolve) => { f.state.releaseModel = resolve; });
        started = new Promise((resolve) => { f.state.modelGate = { mode: "default", wait, release: f.state.releaseModel, started: resolve }; });
        await f.garmentReview(job);
        assert.equal((await f.request(`/api/import/jobs/${job.id}/stages/garment/approve`, "POST", {})).status, 200);
        await deadline(started, "Model fixture never started");
      } else {
        review = await f.modeledReview(job);
      }
      const unhandled = [];
      const observeRejection = (reason) => unhandled.push(reason);
      process.on("unhandledRejection", observeRejection);
      subtest.after(() => process.off("unhandledRejection", observeRejection));
      assert.equal((await f.request(`/api/import/wardrobe/import-${job.id}`, "DELETE")).status, 200);
      assert.deepEqual(await f.library(), []);
      assert.equal((await f.request(`/api/import/jobs/${job.id}`)).status, 404);
      assert.equal((await f.approveModeled(review)).status, 404, "a retained review action cannot recreate a deleted item");
      assert.equal((await f.request(`/api/import/wardrobe/import-${job.id}/modeled`, "POST", {})).status, 404, "the gallery generation route cannot restore a deleted item");
      await assert.rejects(readFile(path.join(f.dataDir, "jobs", job.id, "job.json")), { code: "ENOENT" });
      const reloaded = await f.newApi();
      assert.deepEqual((await f.request("/api/import/wardrobe", "GET", undefined, reloaded)).value, []);
      assert.deepEqual((await f.request("/api/import/jobs", "GET", undefined, reloaded)).value, []);
      f.state.modelGate?.release();
      // Drain the deliberately delayed provider response and the small PNG write.
      await new Promise((resolve) => setTimeout(resolve, 75));
      assert.deepEqual(await f.library(), []);
      assert.equal((await f.request(`/api/import/jobs/${job.id}`)).status, 404);
      assert.deepEqual(unhandled, [], "cancellation must not leave a rejected background worker");
    });
  }
});

test("an abandoned recovery claim is also recovered before writing the wardrobe", async (t) => {
  const f = await fixture(t, []);
  const lock = path.join(f.dataDir, ".library.lock");
  const abandoned = { pid: 2147483647, owner: randomUUID(), hostname: hostname() };
  await writeFile(lock, JSON.stringify(abandoned));
  await writeFile(`${lock}.recovery`, JSON.stringify({ ...abandoned, owner: randomUUID() }));
  const libraryFile = path.join(f.dataDir, "library.json");
  await deadline(withLibraryLock(libraryFile, () => writeFile(libraryFile, JSON.stringify([{ id: "recovered-twice" }]))), "Dead recovery claim blocked the next write", 1500);
  assert.deepEqual((await f.library()).map((record) => record.id), ["recovered-twice"]);
  await assert.rejects(readFile(lock), { code: "ENOENT" });
  await assert.rejects(readFile(`${lock}.recovery`), { code: "ENOENT" });
});

test("a live recovery owner is preserved and the next writer waits for its release", async (t) => {
  const f = await fixture(t, []);
  const lock = path.join(f.dataDir, ".library.lock");
  const recovery = `${lock}.recovery`;
  const liveClaim = JSON.stringify({ pid: process.pid, owner: randomUUID(), hostname: hostname() });
  await writeFile(lock, JSON.stringify({ pid: 2147483647, owner: randomUUID(), hostname: hostname() }));
  await writeFile(recovery, liveClaim);
  let entered = false;
  const libraryFile = path.join(f.dataDir, "library.json");
  const writer = withLibraryLock(libraryFile, async () => {
    entered = true;
    await writeFile(libraryFile, JSON.stringify([{ id: "after-live-release" }]));
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(entered, false, "another writer must not reclaim a live recovery claim");
    assert.equal(await readFile(recovery, "utf8"), liveClaim);
    assert.deepEqual(await f.library(), []);
  } finally {
    // This fixture owns the claim and simulates its owner's normal release.
    await rm(recovery, { force: true });
    await deadline(writer, "Writer did not continue after the owner released its claim", 1500);
  }
  assert.deepEqual((await f.library()).map((record) => record.id), ["after-live-release"]);
});

test("correcting a completed garment generates only its missing layer look and reuses the active job", async (t) => {
  const f = await fixture(t, [item({ canLayer: false })]);
  const [originalJob] = await f.upload();
  const originalReview = await f.modeledReview(originalJob);
  assert.equal((await f.approveModeled(originalReview)).status, 200);
  const [original] = await f.library();
  assert.equal(original.modeledImages.length, 1);
  const originalTopBytes = Buffer.from(await (await fetch(`${f.url}${original.modeledImage}`)).arrayBuffer());
  const manual = await f.request(`/api/import/wardrobe/${original.id}`, "PATCH", { canLayer: true });
  assert.equal(manual.status, 200);
  assert.equal(manual.value.layeringSource, "manual");
  const editCount = f.state.edits.length;
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { f.state.modelGate = { mode: "layer", wait, release, started: resolve }; });
  const create = await f.request(`/api/import/wardrobe/${original.id}/modeled`, "POST", {});
  assert.equal(create.status, 202);
  assert.equal(create.value.job.id, originalJob.id);
  await deadline(started, "Missing layer generation never started");
  const existing = await f.request(`/api/import/wardrobe/${original.id}/modeled`, "POST", {});
  assert.equal(existing.status, 200, "repeated requests reuse the active correction job");
  assert.equal(existing.value.job.id, create.value.job.id);
  assert.deepEqual(f.state.edits.slice(editCount).map((edit) => edit.mode), ["layer"]);
  assert.equal((await f.request("/api/import/jobs")).value.length, 1);
  assert.equal((await f.library())[0].modeledImages.length, 1, "the accepted cover remains intact while its new layer is pending");
  release();
  const review = await f.waitFor(create.value.job.id, "modeled", "review");
  assert.deepEqual(review.stages.modeled.images.map((image) => image.mode), ["default", "layer"]);
  const retained = await fetch(`${f.url}${review.stages.modeled.images[0].image}`);
  assert.deepEqual(Buffer.from(await retained.arrayBuffer()), originalTopBytes, "the accepted standard photo is reused without regeneration");
  const unchecked = await f.request(`/api/import/jobs/${review.id}/stages/modeled/approve`, "POST", { reviewedImageIds: [review.stages.modeled.images[1].id] });
  assert.equal(unchecked.status, 409, "the complete pair still requires review");
  assert.equal((await f.approveModeled(review)).status, 200);
  const records = await f.library();
  assert.equal(records.length, 1);
  const [saved] = records;
  assert.equal(saved.id, original.id);
  assert.equal(saved.image, original.image, "correction does not replace the physical garment");
  assert.equal(saved.modeledImages[0].image, original.modeledImage);
  assert.deepEqual(saved.modeledImages.map((image) => image.mode), ["default", "layer"]);
  assert.equal(saved.canLayer, true);
  assert.equal(saved.layeringSource, "manual");
  const complete = await f.request(`/api/import/wardrobe/${original.id}/modeled`, "POST", {});
  assert.equal(complete.status, 409, "a completed pair cannot create another redundant image batch");
  assert.deepEqual(f.state.edits.slice(editCount).map((edit) => edit.mode), ["layer"]);
  assert.equal(f.state.analysis.length, 1, "correcting classification does not reanalyze the source photo");
  assert.equal((await f.request(`/api/import/wardrobe/${original.id}`, "DELETE")).status, 200);
  assert.equal((await f.request(`/api/import/wardrobe/${original.id}/modeled`, "POST", {})).status, 404);
  assert.deepEqual(await f.library(), []);
  assert.deepEqual(f.state.edits.slice(editCount).map((edit) => edit.mode), ["layer"]);
});

test("legacy shirt metadata and top modes migrate without replacing accepted photos or item identity", async (t) => {
  const id = `import-${randomUUID()}`;
  const image = `/api/import/library/${id}-garment.png`;
  const modeledImage = `/api/import/library/${id}-modeled.png`;
  const f = await fixture(t, [], [{
    ...item({ isShirt: true, canLayer: false }), id, image, thumbnail: image, modeledImage,
    modeledImages: [{ id: "accepted-top", mode: "top", image: modeledImage }],
    modeledLayering: { isShirt: true, canLayer: false, layeringSource: "ai" },
  }]);
  const oldPhoto = await png();
  await writeFile(path.join(f.dataDir, "imported", `${id}-garment.png`), await png(80, 100));
  await writeFile(path.join(f.dataDir, "imported", `${id}-modeled.png`), oldPhoto);
  const [legacy] = await f.library();
  assert.equal(Object.hasOwn(legacy, "isShirt"), false);
  assert.equal(Object.hasOwn(legacy.modeledLayering, "isShirt"), false);
  assert.deepEqual(legacy.modeledImages, [{ id: "accepted-top", mode: "default", image: modeledImage }]);
  const patched = await f.request(`/api/import/wardrobe/${id}`, "PATCH", { canLayer: true });
  assert.equal(patched.status, 200);
  assert.equal(Object.hasOwn(patched.value, "isShirt"), false);
  const persisted = JSON.parse(await readFile(path.join(f.dataDir, "library.json"), "utf8"));
  assert.equal(JSON.stringify(persisted).includes('"isShirt"'), false);
  const created = await f.request(`/api/import/wardrobe/${id}/modeled`, "POST", {});
  assert.equal(created.status, 202);
  assert.equal(Object.hasOwn(created.value.job.metadata, "isShirt"), false);
  const review = await f.waitFor(created.value.job.id, "modeled", "review");
  assert.deepEqual(f.state.edits.map((edit) => edit.mode), ["layer"]);
  assert.deepEqual(review.stages.modeled.images.map((entry) => entry.mode), ["default", "layer"]);
  assert.equal(review.stages.modeled.images[0].id, "accepted-top");
  assert.equal(Object.hasOwn(review.stages.modeled.generationLayering, "isShirt"), false);
  assert.deepEqual(Buffer.from(await (await fetch(`${f.url}${review.stages.modeled.images[0].image}`)).arrayBuffer()), oldPhoto);
  assert.equal((await f.approveModeled(review)).status, 200);
  const [saved] = await f.library();
  assert.equal(saved.id, id);
  assert.equal(saved.modeledImages.length, 2);
  assert.equal(saved.image, image);
  assert.equal(Object.hasOwn(saved, "isShirt"), false);
});

test("stale provider and persisted job shirt flags are discarded by the general layer contract", async (t) => {
  const f = await fixture(t, [item({ name: "Legacy Jacket", part: "wholebody_up", isShirt: false })]);
  const [job] = await f.upload();
  assert.equal(job.metadata.canLayer, true, "old shirt flags cannot gate a jacket's layer eligibility");
  assert.equal(Object.hasOwn(job.metadata, "isShirt"), false);
  const jobFile = path.join(f.dataDir, "jobs", job.id, "job.json");
  const stale = JSON.parse(await readFile(jobFile, "utf8"));
  stale.metadata.isShirt = false;
  stale.stages.modeled.generationLayering = { isShirt: false, canLayer: true, layeringSource: "ai" };
  stale.stages.modeled.images = [{ id: "legacy-top", mode: "top", image: "/api/import/library/legacy-photo.png" }];
  await writeFile(jobFile, JSON.stringify(stale));
  const reloaded = await f.newApi();
  const response = await f.request(`/api/import/jobs/${job.id}`, "GET", undefined, reloaded);
  assert.equal(response.status, 200);
  assert.equal(Object.hasOwn(response.value.metadata, "isShirt"), false);
  assert.equal(Object.hasOwn(response.value.stages.modeled.generationLayering, "isShirt"), false);
  assert.equal(response.value.stages.modeled.images[0].mode, "default");
});
