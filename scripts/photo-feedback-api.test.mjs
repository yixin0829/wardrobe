import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { wardrobeImportApi } from "./import-job-api.mjs";
import { archiveGeneratedPhoto } from "./photo-history.mjs";

const TOP_ID = "import-44444444-1111-4111-8111-111111111111";
const BOTTOM_ID = "import-55555555-1111-4111-8111-111111111111";
const OUTER_ID = "import-66666666-1111-4111-8111-111111111111";
const OUTFIT_ID = "flannel-and-denim";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const png = (width, height, color) => sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer();

async function deadline(promise, message, milliseconds = 6000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]);
  } finally { clearTimeout(timer); }
}

async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
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

// Exercise the actual middleware over HTTP with disposable anonymous files.
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "wardrobe-photo-tests-"));
  const dataDir = path.join(directory, "data");
  await mkdir(path.join(dataDir, "imported"), { recursive: true });
  await mkdir(path.join(dataDir, "outfit-images"));
  const assets = {
    "face.png": await png(48, 64, "#887766"),
    "body-2.png": await png(48, 96, "#665544"),
    "body-3.png": await png(64, 96, "#554433"),
    "top.png": await png(48, 64, "#a35431"),
    "bottom.png": await png(48, 80, "#274157"),
    "outer.png": await png(48, 64, "#4d6474"),
    "top-default.png": await png(96, 64, "#887744"),
    "top-layer.png": await png(96, 64, "#776644"),
    "outfit.png": await png(96, 96, "#665544"),
  };
  await writeFile(path.join(dataDir, "model-reference.png"), assets["face.png"]);
  await writeFile(path.join(dataDir, "model-reference-2.png"), assets["body-2.png"]);
  await writeFile(path.join(dataDir, "model-reference-3.png"), assets["body-3.png"]);
  for (const name of ["top.png", "bottom.png", "outer.png", "top-default.png", "top-layer.png"]) await writeFile(path.join(dataDir, "imported", name), assets[name]);
  await writeFile(path.join(dataDir, "outfit-images", `${OUTFIT_ID}.png`), assets["outfit.png"]);
  const library = [
    { id: TOP_ID, name: "Rust Cotton Tee", part: "upperbody", color: "#a35431", canLayer: true, image: "/api/import/library/top.png", modeledImage: "/api/import/library/top-default.png", modeledImages: [{ id: "original-default", mode: "default", image: "/api/import/library/top-default.png" }, { id: "original-layer", mode: "layer", image: "/api/import/library/top-layer.png" }] },
    { id: BOTTOM_ID, name: "Indigo Jeans", part: "lowerbody", color: "#274157", canLayer: false, image: "/api/import/library/bottom.png" },
    { id: OUTER_ID, name: "Blue Flannel Overshirt", part: "upperbody", color: "#4d6474", canLayer: true, image: "/api/import/library/outer.png" },
  ];
  const outfit = { id: OUTFIT_ID, name: "Flannel & Denim", status: "accepted", occasion: ["casual"], setting: "a quiet waterfront promenade", image: `outfit-images/${OUTFIT_ID}.png`, garmentIds: [TOP_ID, BOTTOM_ID, OUTER_ID], garmentModes: [{ garmentId: TOP_ID, role: "top", mode: "default" }, { garmentId: BOTTOM_ID, role: "bottom", mode: "default" }, { garmentId: OUTER_ID, role: "outer", mode: "layer" }] };
  await writeFile(path.join(dataDir, "library.json"), JSON.stringify(library));
  await writeFile(path.join(dataDir, "outfits.json"), JSON.stringify({ version: 1, outfits: [outfit] }));
  const state = { now: Date.parse("2026-10-08T16:00:00Z"), edits: [], providerErrors: [], failure: false, invalidAspect: false, gate: null };
  const provider = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, "Bearer wardrobe-photo-test-only");
      assert.equal(req.url, "/v1/images/edits");
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const form = await new Response(Buffer.concat(chunks), { headers: { "Content-Type": req.headers["content-type"] } }).formData();
      const files = await Promise.all(form.getAll("image[]").map(async (file) => ({ name: file.name, bytes: Buffer.from(await file.arrayBuffer()) })));
      const request = { size: form.get("size"), prompt: form.get("prompt"), files };
      state.edits.push(request);
      if (state.gate) { state.gate.started(); await state.gate.wait; }
      if (state.failure) return respond(res, 503, { error: { message: "Local fixture generation unavailable" } });
      const square = request.size === "1024x1024";
      request.output = await png(state.invalidAspect ? 48 : 96, state.invalidAspect ? 128 : square ? 96 : 64, { r: 80 + state.edits.length, g: 120, b: 140, alpha: 1 });
      return respond(res, 200, { data: [{ b64_json: request.output.toString("base64") }] });
    } catch (error) {
      state.providerErrors.push(error.message);
      return respond(res, 500, { error: { message: error.message } });
    }
  });
  const providerUrl = await listen(provider);
  const servers = [];
  const env = { OPENAI_API_KEY: "wardrobe-photo-test-only", OPENAI_API_BASE_URL: `${providerUrl}/v1`, WARDROBE_DATA_DIR: "data", WARDROBE_MODEL_REFERENCE: "data/model-reference.png", WARDROBE_MODEL_DIRECTION: "Preserve the supplied long-leg proportions" };
  async function newApi() {
    const plugin = wardrobeImportApi({ env, now: () => state.now });
    await plugin.configResolved({ root: directory });
    const handlers = [];
    plugin.configureServer({ middlewares: { use(handler) { handlers.push(handler); } } });
    const server = createServer((req, res) => {
      let index = 0;
      const next = () => { const handler = handlers[index++]; if (handler) void handler(req, res, next); else { res.statusCode = 404; res.end(); } };
      next();
    });
    const url = await listen(server);
    servers.push(server);
    return url;
  }
  const url = await newApi();
  t.after(async () => {
    state.gate?.release();
    await Promise.all(servers.map(close));
    await close(provider);
    const absolute = path.resolve(directory);
    assert.equal(path.dirname(absolute), path.resolve(tmpdir()));
    assert.ok(path.basename(absolute).startsWith("wardrobe-photo-tests-"));
    await rm(absolute, { recursive: true, force: true });
    assert.deepEqual(state.providerErrors, [], "the fake provider must receive valid edit requests");
  });
  async function request(route, method = "GET", value, base = url) {
    const response = await fetch(`${base}${route}`, { method, ...(value === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }) });
    return { status: response.status, value: await response.json() };
  }
  function route(kind = "item", id = kind === "item" ? TOP_ID : OUTFIT_ID) { return `/api/import/photos/${kind}/${id}`; }
  async function photos(kind = "item", id, base = url) {
    const result = await request(route(kind, id), "GET", undefined, base);
    assert.equal(result.status, 200, JSON.stringify(result.value));
    return result.value.photos;
  }
  async function waitFor(predicate, kind = "item", id) {
    const deadline = Date.now() + 6000;
    let last;
    while (Date.now() < deadline) {
      last = await photos(kind, id);
      if (predicate(last)) return last;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    assert.fail(`Timed out waiting for photo result: ${JSON.stringify(last)}`);
  }
  async function bytes(image) {
    const response = await fetch(`${url}${image}`);
    assert.equal(response.status, 200, image);
    return Buffer.from(await response.arrayBuffer());
  }
  async function history() { return JSON.parse(await readFile(path.join(dataDir, "photo-history", "index.json"), "utf8")); }
  function gate() {
    let signal, release;
    const started = new Promise((resolve) => { signal = resolve; });
    const wait = new Promise((resolve) => { release = resolve; });
    state.gate = { started: signal, wait, release };
    return { started, release };
  }
  return { dataDir, assets, state, newApi, url, request, route, photos, waitFor, bytes, history, gate };
}

test("original photos are archived without changing their bytes and feedback belongs to one exact version", async (t) => {
  const f = await fixture(t);
  const originals = await f.photos();
  assert.deepEqual(originals.map((photo) => photo.mode).sort(), ["default", "layer"]);
  for (const photo of originals) {
    assert.equal(hash(await f.bytes(photo.image)), hash(f.assets[`top-${photo.mode}.png`]));
    assert.equal(photo.feedback, null);
    assert.equal(photo.versions.length, 1);
  }
  const original = originals.find((photo) => photo.mode === "default");
  const result = await f.request(`${f.route()}/feedback`, "POST", { versionId: original.versionId, rating: "up", comment: "The proportions are balanced." });
  assert.equal(result.status, 200);
  const secondApi = await f.newApi();
  const reloaded = await f.photos("item", TOP_ID, secondApi);
  assert.equal(reloaded.find((photo) => photo.mode === "default").feedback.rating, "up");
  assert.equal(reloaded.find((photo) => photo.mode === "default").feedback.comment, "The proportions are balanced.");
  assert.equal(reloaded.find((photo) => photo.mode === "layer").feedback, null);
  assert.equal(reloaded[0].versions.length, 1, "restarting must not duplicate original versions");
  assert.equal(hash(await readFile(path.join(f.dataDir, "imported", "top-default.png"))), hash(f.assets["top-default.png"]));
  assert.equal((await f.request(`${f.route()}/feedback`, "POST", { versionId: original.versionId, rating: "sideways", comment: "" })).status, 400);
  assert.equal((await f.request(`${f.route("outfit")}/feedback`, "POST", { versionId: original.versionId, rating: "down", comment: "Wrong owner" })).status, 404);
});

test("regeneration replaces only the selected mode and one-minute Undo survives reload while retaining every version", async (t) => {
  const f = await fixture(t);
  const initial = await f.photos();
  const original = initial.find((photo) => photo.mode === "default");
  const layer = initial.find((photo) => photo.mode === "layer");
  assert.equal((await f.request(`${f.route()}/feedback`, "POST", { versionId: original.versionId, rating: "up", comment: "Keep this baseline." })).status, 200);
  assert.equal((await f.request(`${f.route()}/regenerate`, "POST", { mode: "default", direction: "Keep the hem visible.", expectedVersionId: original.versionId })).status, 202);
  const regenerated = (await f.waitFor((photos) => photos.some((photo) => photo.mode === "default" && !photo.generating && photo.versionId !== original.versionId))).find((photo) => photo.mode === "default");
  assert.equal(f.state.edits.length, 1);
  assert.match(f.state.edits[0].prompt, /Keep the hem visible/);
  assert.equal(regenerated.versions.length, 2);
  assert.equal(regenerated.undo.previousVersionId, original.versionId);
  assert.equal(Date.parse(regenerated.undo.expiresAt) - f.state.now, 60000);
  assert.notEqual(regenerated.image, original.image);
  assert.equal(hash(await f.bytes(regenerated.image)), hash(f.state.edits[0].output));
  assert.equal((await f.photos()).find((photo) => photo.mode === "layer").versionId, layer.versionId);
  assert.equal((await f.request(`${f.route()}/feedback`, "POST", { versionId: regenerated.versionId, rating: "down", comment: "This hem is less accurate." })).status, 200);
  f.state.now += 59000;
  const secondApi = await f.newApi();
  const reloaded = (await f.photos("item", TOP_ID, secondApi)).find((photo) => photo.mode === "default");
  assert.equal(reloaded.undo.previousVersionId, original.versionId);
  assert.equal((await f.request(`${f.route()}/undo`, "POST", { mode: "default", expectedVersionId: regenerated.versionId }, secondApi)).status, 200);
  const undone = (await f.photos()).find((photo) => photo.mode === "default");
  assert.equal(undone.versionId, original.versionId);
  assert.equal(undone.feedback.rating, "up");
  assert.equal(undone.versions.find((version) => version.id === regenerated.versionId).feedback.comment, "This hem is less accurate.");
  assert.equal(undone.undo, null);
  assert.equal(hash(await f.bytes(regenerated.image)), hash(f.state.edits[0].output), "Undo must retain the rejected image bytes");
  const savedHistory = await f.history();
  const target = savedHistory.targets.find((target) => target.kind === "item" && target.targetId === TOP_ID && target.mode === "default");
  assert.match(JSON.stringify(savedHistory), /Keep the hem visible/);
  assert.ok(target.events.some((event) => event.type === "regenerate" && event.fromVersionId === original.versionId), "implicit regeneration preference is distinct from explicit feedback");
  assert.ok(target.events.some((event) => event.type === "undo" && event.fromVersionId === regenerated.versionId));
  assert.equal((await f.request(`${f.route()}/feedback`, "POST", { versionId: regenerated.versionId, rating: "up", comment: "The colors were still good." })).status, 200, "feedback may target a historical photo in the same scope");
  const feedbackEvents = (await f.history()).targets.find((target) => target.kind === "item" && target.targetId === TOP_ID && target.mode === "default").events.filter((event) => event.type === "feedback");
  assert.ok(feedbackEvents.some((event) => event.comment === "This hem is less accurate."));
  assert.ok(feedbackEvents.some((event) => event.comment === "The colors were still good."), "later feedback never removes the prior feedback event");
});

test("a failed follow-up regeneration preserves the remaining Undo window of the accepted photo", async (t) => {
  const f = await fixture(t);
  const original = (await f.photos()).find((photo) => photo.mode === "default");
  assert.equal((await f.request(`${f.route()}/regenerate`, "POST", { mode: "default", expectedVersionId: original.versionId })).status, 202);
  const accepted = (await f.waitFor((photos) => photos.some((photo) => photo.mode === "default" && !photo.generating && photo.versionId !== original.versionId))).find((photo) => photo.mode === "default");
  f.state.now += 10000;
  f.state.failure = true;
  assert.equal((await f.request(`${f.route()}/regenerate`, "POST", { mode: "default", expectedVersionId: accepted.versionId })).status, 202);
  const failed = (await f.waitFor((photos) => photos.some((photo) => photo.mode === "default" && !photo.generating && photo.error))).find((photo) => photo.mode === "default");
  assert.equal(failed.versionId, accepted.versionId);
  assert.equal(failed.undo.expiresAt, accepted.undo.expiresAt, "failure neither removes nor extends the original deadline");
  assert.equal((await f.request(`${f.route()}/undo`, "POST", { mode: "default", expectedVersionId: accepted.versionId })).status, 200);
  assert.equal((await f.photos()).find((photo) => photo.mode === "default").versionId, original.versionId);
  assert.equal(hash(await f.bytes(accepted.image)), hash(f.state.edits[0].output));
});

test("Undo expiry is checked by the server and expired and stale requests preserve all archived images", async (t) => {
  const f = await fixture(t);
  const original = (await f.photos()).find((photo) => photo.mode === "default");
  assert.equal((await f.request(`${f.route()}/regenerate`, "POST", { mode: "default", expectedVersionId: original.versionId })).status, 202);
  const generated = (await f.waitFor((photos) => photos.some((photo) => photo.mode === "default" && !photo.generating && photo.versionId !== original.versionId))).find((photo) => photo.mode === "default");
  f.state.now += 60000;
  assert.equal((await f.request(`${f.route()}/undo`, "POST", { mode: "default", expectedVersionId: generated.versionId })).status, 409);
  assert.equal((await f.request(`${f.route()}/regenerate`, "POST", { mode: "default", expectedVersionId: original.versionId })).status, 409);
  const current = (await f.photos()).find((photo) => photo.mode === "default");
  assert.equal(current.versionId, generated.versionId);
  assert.equal(current.undo, null);
  assert.equal(f.state.edits.length, 1);
  assert.equal(hash(await f.bytes(original.image)), hash(f.assets["top-default.png"]));
  assert.equal(hash(await f.bytes(generated.image)), hash(f.state.edits[0].output));
});

test("provider failure and invalid aspect ratio keep the accepted image and retain returned rejected bytes", async (t) => {
  const f = await fixture(t);
  const original = (await f.photos()).find((photo) => photo.mode === "default");
  f.state.failure = true;
  assert.equal((await f.request(`${f.route()}/regenerate`, "POST", { mode: "default", expectedVersionId: original.versionId })).status, 202);
  const failed = (await f.waitFor((photos) => photos.some((photo) => photo.mode === "default" && !photo.generating && photo.error))).find((photo) => photo.mode === "default");
  assert.equal(failed.versionId, original.versionId);
  assert.equal(failed.undo, null);
  f.state.failure = false;
  f.state.invalidAspect = true;
  assert.equal((await f.request(`${f.route()}/regenerate`, "POST", { mode: "default", expectedVersionId: original.versionId })).status, 202);
  await f.waitFor((photos) => photos.some((photo) => photo.mode === "default" && !photo.generating && photo.error));
  const invalid = (await f.photos()).find((photo) => photo.mode === "default");
  assert.equal(invalid.versionId, original.versionId);
  const rejected = invalid.versions.find((version) => version.status === "invalid");
  assert.ok(rejected, "a returned image with invalid dimensions still belongs in history");
  assert.equal(hash(await f.bytes(rejected.image)), hash(f.state.edits.at(-1).output));
  assert.equal(hash(await f.bytes(original.image)), hash(f.assets["top-default.png"]));
  const files = await readdir(path.join(f.dataDir, "photo-history"));
  assert.ok(files.includes("index.json"));
});

test("two API instances cannot regenerate the same mode concurrently or overwrite a newer accepted version", async (t) => {
  const f = await fixture(t);
  const original = (await f.photos()).find((photo) => photo.mode === "default");
  const secondApi = await f.newApi();
  const gate = f.gate();
  assert.equal((await f.request(`${f.route()}/regenerate`, "POST", { mode: "default", expectedVersionId: original.versionId })).status, 202);
  await deadline(gate.started, "The first regeneration did not reach the provider");
  assert.equal((await f.request(`${f.route()}/regenerate`, "POST", { mode: "default", expectedVersionId: original.versionId }, secondApi)).status, 409);
  assert.equal((await f.request(`${f.route()}/undo`, "POST", { mode: "default", expectedVersionId: original.versionId }, secondApi)).status, 409);
  gate.release();
  const generated = (await f.waitFor((photos) => photos.some((photo) => photo.mode === "default" && !photo.generating && photo.versionId !== original.versionId))).find((photo) => photo.mode === "default");
  assert.equal((await f.request(`${f.route()}/regenerate`, "POST", { mode: "default", expectedVersionId: original.versionId }, secondApi)).status, 409);
  assert.equal((await f.photos("item", TOP_ID, secondApi)).find((photo) => photo.mode === "default").versionId, generated.versionId);
  assert.equal(f.state.edits.length, 1);
});

test("a delayed web regeneration cannot replace a newer agent-approved image", async (t) => {
  const f = await fixture(t);
  const original = (await f.photos()).find((photo) => photo.mode === "default");
  const gate = f.gate();
  assert.equal((await f.request(`${f.route()}/regenerate`, "POST", { mode: "default", expectedVersionId: original.versionId })).status, 202);
  await deadline(gate.started, "The pending regeneration did not reach the provider");
  const agentBytes = await png(96, 64, "#ddaa77");
  const agentVersion = await archiveGeneratedPhoto({
    dataDir: f.dataDir, kind: "item", targetId: TOP_ID, mode: "default",
    bytes: agentBytes, source: "agent", status: "accepted", activate: true,
    prompt: "Newer agent-approved fixture prompt", promptRevisionId: "default",
  });
  assert.equal((await f.photos()).find((photo) => photo.mode === "default").versionId, agentVersion.id);
  gate.release();
  const current = (await f.waitFor((photos) => photos.some((photo) => photo.mode === "default" && !photo.generating))).find((photo) => photo.mode === "default");
  assert.equal(current.versionId, agentVersion.id, "a late result must preserve the newer accepted image");
  assert.equal(current.undo, null, "a stale result must not offer Undo against a newer generation");
  const lateVersion = current.versions.find((version) => version.source === "regeneration");
  assert.ok(lateVersion, "the late provider result still belongs in history");
  assert.equal(lateVersion.status, "rejected");
  assert.equal(hash(await f.bytes(lateVersion.image)), hash(f.state.edits[0].output));
  assert.equal(hash(await f.bytes(agentVersion.image)), hash(agentBytes));
  assert.equal(hash(await f.bytes(original.image)), hash(f.assets["top-default.png"]));
  const restarted = (await f.photos("item", TOP_ID, await f.newApi())).find((photo) => photo.mode === "default");
  assert.equal(restarted.versionId, agentVersion.id, "the newer accepted image must survive a server restart");
});

test("complete outfit regeneration uses every exact garment and body reference, stores prompt context, and supports version feedback", async (t) => {
  const f = await fixture(t);
  const outfits = await f.request("/api/import/outfits");
  assert.equal(outfits.status, 200);
  assert.equal(outfits.value[0].id, OUTFIT_ID);
  const [original] = await f.photos("outfit");
  assert.equal(hash(await f.bytes(original.image)), hash(f.assets["outfit.png"]));
  const calibrated = await f.request("/api/import/prompt-calibration", "POST", { guidance: "Prefer a restrained charcoal background for readable layering.", reason: "The accepted baseline keeps the clothes easy to compare.", sourceVersionIds: [original.versionId], sourceEventIds: [] });
  assert.equal(calibrated.status, 200);
  assert.equal((await f.request(`${f.route("outfit")}/regenerate`, "POST", { mode: "default", direction: "Show the inner tee clearly at the open placket.", expectedVersionId: original.versionId })).status, 202);
  const [generated] = await f.waitFor((photos) => !photos[0].generating && photos[0].versionId !== original.versionId, "outfit");
  const edit = f.state.edits[0];
  assert.equal(edit.size, "1024x1024");
  const provided = new Set(edit.files.map((file) => hash(file.bytes)));
  for (const name of ["face.png", "body-2.png", "body-3.png", "top.png", "bottom.png", "outer.png"]) assert.ok(provided.has(hash(f.assets[name])), `${name} must be sent unchanged to the provider`);
  for (const text of ["Rust Cotton Tee", "Indigo Jeans", "Blue Flannel Overshirt", "long-leg", "inner tee clearly", "restrained charcoal background"]) assert.ok(edit.prompt.includes(text), text);
  const dimensions = await sharp(await f.bytes(generated.image)).metadata();
  assert.equal(dimensions.width, dimensions.height);
  const persisted = JSON.stringify(await f.history());
  assert.ok(persisted.includes("Show the inner tee clearly at the open placket."));
  assert.ok(persisted.includes(TOP_ID) && persisted.includes(BOTTOM_ID) && persisted.includes(OUTER_ID), "generation context keeps the selected garment IDs");
  assert.equal(generated.versions.find((version) => version.id === generated.versionId).promptRevisionId, calibrated.value.activeRevisionId, "generated versions record the exact active prompt revision");
  assert.equal((await f.request(`${f.route("outfit")}/feedback`, "POST", { versionId: generated.versionId, rating: "up", comment: "Good balance and visible layers." })).status, 200);
  const reloaded = await f.photos("outfit", OUTFIT_ID, await f.newApi());
  assert.equal(reloaded[0].feedback.comment, "Good balance and visible layers.");
  assert.equal(hash(await f.bytes(original.image)), hash(f.assets["outfit.png"]));
  const reset = await f.request("/api/import/prompt-calibration/reset", "POST", {});
  assert.equal(reset.status, 200);
  assert.equal(reset.value.activeRevisionId, "default");
  assert.equal(reset.value.isDefault, true);
  assert.equal(reset.value.revisions.length, 1, "reset retains the learned revision for comparison");
});

test("a complete outfit stays visible and rateable after one referenced garment is deleted", async (t) => {
  const f = await fixture(t);
  const [original] = await f.photos("outfit");
  assert.equal((await f.request(`${f.route("outfit")}/regenerate`, "POST", { mode: "default", expectedVersionId: original.versionId })).status, 202);
  const [generated] = await f.waitFor((photos) => !photos[0].generating && photos[0].versionId !== original.versionId, "outfit");
  assert.equal((await f.request(`/api/import/wardrobe/${TOP_ID}`, "DELETE")).status, 200);
  const outfits = await f.request("/api/import/outfits");
  assert.equal(outfits.status, 200);
  assert.equal(outfits.value.find((outfit) => outfit.id === OUTFIT_ID).image, generated.image, "the gallery keeps the latest outfit rather than reverting to its original manifest image");
  const [current] = await f.photos("outfit");
  assert.equal(current.versionId, generated.versionId);
  const feedback = await f.request(`${f.route("outfit")}/feedback`, "POST", { versionId: generated.versionId, rating: "up", comment: "Keep this balanced look as a reference." });
  assert.equal(feedback.status, 200);
  assert.equal(feedback.value.photos[0].feedback.comment, "Keep this balanced look as a reference.");
  const regeneration = await f.request(`${f.route("outfit")}/regenerate`, "POST", { mode: "default", expectedVersionId: generated.versionId });
  assert.equal(regeneration.status, 409, "a new photo requires the missing garment even though viewing and feedback do not");
  assert.equal(f.state.edits.length, 1, "missing garment validation must happen before contacting the provider");
  assert.equal(hash(await f.bytes(original.image)), hash(f.assets["outfit.png"]));
  assert.equal(hash(await f.bytes(generated.image)), hash(f.state.edits[0].output));
  const [restarted] = await f.photos("outfit", OUTFIT_ID, await f.newApi());
  assert.equal(restarted.versionId, generated.versionId);
  assert.equal(restarted.feedback.rating, "up");
});

test("deleting an item during regeneration cannot resurrect it and retains original and returned image history", async (t) => {
  const f = await fixture(t);
  const original = (await f.photos()).find((photo) => photo.mode === "default");
  const gate = f.gate();
  assert.equal((await f.request(`${f.route()}/regenerate`, "POST", { mode: "default", expectedVersionId: original.versionId })).status, 202);
  await deadline(gate.started, "The pending regeneration did not reach the provider");
  assert.equal((await f.request(`/api/import/wardrobe/${TOP_ID}`, "DELETE")).status, 200);
  gate.release();
  const timeoutAt = Date.now() + 6000;
  let persisted;
  do {
    persisted = await f.history();
    if (JSON.stringify(persisted).includes("rejected")) break;
    await new Promise((resolve) => setTimeout(resolve, 15));
  } while (Date.now() < timeoutAt);
  const library = await f.request("/api/import/wardrobe");
  assert.equal(library.value.some((item) => item.id === TOP_ID), false);
  assert.equal((await f.request(f.route())).status, 404);
  assert.equal(hash(await f.bytes(original.image)), hash(f.assets["top-default.png"]));
  const archived = persisted.targets.flatMap((target) => target.versions).find((version) => version.source === "regeneration");
  assert.ok(archived, "the cancelled generation must still be retained as evidence");
  assert.equal(archived.status, "rejected");
  assert.equal(hash(await f.bytes(archived.image)), hash(f.state.edits[0].output));
});
