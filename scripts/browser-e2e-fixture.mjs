import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Disposable, local-only fixtures. Never load .env or the real wardrobe data.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(repo, "package.json"));
const sharp = require("sharp");
const { createServer: createVite } = await import(pathToFileURL(require.resolve("vite")));
const { default: react } = await import(pathToFileURL(require.resolve("@vitejs/plugin-react")));
const { wardrobeImportApi } = await import(pathToFileURL(path.join(repo, "scripts/import-job-api.mjs")));
const work = await mkdtemp(path.join(tmpdir(), "wardrobe-browser-e2e-"));
const dataDir = path.join(work, "fixture-data");
const fixtureDir = path.join(work, "inputs");
const state = { analysis: [], edits: [], errors: [], fixtureOnly: true };
let provider;
let vite;
let stopping = false;

async function cleanup() {
  const closures = [];
  if (vite) closures.push(vite.close());
  if (provider) {
    provider.closeAllConnections();
    closures.push(new Promise((resolve) => provider.close(resolve)));
  }
  await Promise.allSettled(closures);
  const resolved = path.resolve(work);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith("wardrobe-browser-e2e-")) throw new Error("Invalid fixture cleanup target");
  await rm(resolved, { recursive: true, force: true });
}

async function stop() {
  if (stopping) return;
  stopping = true;
  try { await cleanup(); process.exit(0); }
  catch (error) { console.error(error.message); process.exit(1); }
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const frame = (body, background, width = 512, height = 640) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${background ? `<rect width="100%" height="100%" fill="${background}"/>` : ""}${body}</svg>`;
const png = (svg) => sharp(Buffer.from(svg)).ensureAlpha().png().toBuffer();
const shirt = (color, flannel = false) => `
  <defs><pattern id="plaid" width="42" height="42" patternUnits="userSpaceOnUse"><rect width="42" height="42" fill="${color}"/><path d="M0 12H42M12 0V42" stroke="#879aa8" stroke-width="8"/><path d="M0 32H42M32 0V42" stroke="#263f51" stroke-width="3"/></pattern></defs>
  <path d="M170 98L225 72H287L342 98L422 260L371 288L331 211V537H181V211L141 288L90 260Z" fill="${flannel ? "url(#plaid)" : color}" stroke="#274153" stroke-width="3"/>
  <path d="M225 72L256 117L287 72L301 114L266 138H246L211 114Z" fill="${color}" stroke="#274153" stroke-width="3"/>
  <path d="M256 140V537" stroke="#274153" stroke-width="5"/>
  ${[178, 244, 310, 376, 442, 508].map((y) => `<circle cx="256" cy="${y}" r="4" fill="#e0d7c7"/>`).join("")}`;
const tee = `<path d="M168 132L218 105Q256 146 294 105L344 132L405 228L357 267L323 225V531H189V225L155 267L107 228Z" fill="#b56543" stroke="#84452d" stroke-width="3"/><path d="M218 105Q256 164 294 105" fill="none" stroke="#84452d" stroke-width="7"/>`;
const jacket = `<path d="M170 98L224 78H288L342 98L422 260L371 288L331 211V537H181V211L141 288L90 260Z" fill="#60765d" stroke="#344831" stroke-width="4"/><path d="M224 78L239 125H273L288 78M256 125V537" fill="none" stroke="#d5cdbb" stroke-width="7"/><path d="M194 359L231 345M281 345L318 359" stroke="#d5cdbb" stroke-width="5"/><path d="M181 515H331M106 252L142 275M370 275L406 252" stroke="#344831" stroke-width="12"/>`;
const trousers = (color, margin = 0) => `<g transform="translate(0 ${margin})"><path d="M177 72H335L342 303L323 556H267L256 298L245 556H189L170 303Z" fill="${color}" stroke="#5b5e62" stroke-width="3"/><path d="M177 103H335M256 75V193M188 112Q188 158 218 161M324 112Q324 158 294 161" fill="none" stroke="#c4baa9" stroke-width="3"/></g>`;

function modeled(mode, name) {
  const layer = mode === "layer";
  const flannel = /flannel/i.test(name);
  const isJacket = /jacket/i.test(name);
  const color = flannel ? "#436377" : isJacket ? "#60765d" : /tee/i.test(name) ? "#b56543" : "#d2dfdc";
  const innerTop = isJacket ? `<path d="M332 146Q362 128 391 146L390 275H324Z" fill="#ccc8bf"/><path d="M340 147Q330 131 343 117Q362 107 381 117Q394 131 384 147" fill="none" stroke="#ccc8bf" stroke-width="9"/><path d="M342 159V207M381 159V207" stroke="#8b8982" stroke-width="2"/>` : `<path d="M332 145H382L391 275H323Z" fill="#f7f4ed"/>`;
  const torso = layer
    ? `${innerTop}<path d="M312 138L342 131L335 288L307 275L306 185L287 243L271 236Z" fill="${color}"/><path d="M382 131L412 138L452 236L435 243L416 185L417 275L389 288Z" fill="${color}"/>`
    : `<path d="M312 138L342 131H382L412 138L452 236L435 243L410 185L413 282H310L314 185L289 243L272 236Z" fill="${color}"/><path d="M342 131L362 152L382 131" fill="none" stroke="#264254" stroke-width="3"/><path d="M362 152V282" stroke="#2a4658" stroke-width="2"/>${[170, 194, 218, 242, 266].map((y) => `<circle cx="362" cy="${y}" r="2.2" fill="#efe6d5"/>`).join("")}`;
  return frame(`
    <rect x="32" y="30" width="215" height="360" rx="6" fill="#d9c9b5"/>
    <rect x="44" y="42" width="192" height="235" rx="88" fill="#b9b6a3"/>
    <path d="M0 348H720V480H0Z" fill="#c5b397"/>
    <path d="M572 360V176M572 235Q516 226 522 192Q569 189 572 235M572 268Q632 257 624 219Q578 224 572 268" fill="#617c61" stroke="#617c61" stroke-width="7"/>
    <ellipse cx="362" cy="423" rx="88" ry="13" fill="#a18d71" opacity=".35"/>
    <circle cx="362" cy="90" r="28" fill="#c0aa8a"/>
    <path d="M342 114H382V144H342Z" fill="#c0aa8a"/>
    <path d="M310 276H413L404 415H372L362 315L352 415H320Z" fill="#484d52"/>
    <path d="M320 411H351L357 428H312Z M373 411H404L415 428H370Z" fill="#272f35"/>
    ${torso}
    ${flannel ? `<path d="${layer ? "M315 158L334 163M311 182L332 189M311 208L330 214M390 163L411 158M392 189L416 182M395 214L418 208" : "M309 170H415M309 196H417M308 222H416M309 248H414M332 144V282M389 144V282"}" fill="none" stroke="#8aa0ac" stroke-width="5" opacity=".8"/>` : ""}
    <path d="M273 235L265 258M450 235L459 258" stroke="#c0aa8a" stroke-width="13" stroke-linecap="round"/>
  `, "#ede6db", 720, 480);
}

try {
  await mkdir(fixtureDir, { recursive: true });
  await mkdir(path.join(dataDir, "imported"), { recursive: true });
  const fixtureNames = ["blue-flannel-shirt.png", "rust-cotton-tee.png", "formal-dress-shirt.png", "olive-zip-jacket.png"];
  const sources = [frame(shirt("#436377", true), "#ebf0f4"), frame(tee, "#f5eee7"), frame(shirt("#d2dfdc"), "#edf1ef"), frame(jacket, "#e4ece3")];
  await Promise.all(sources.map(async (svg, index) => writeFile(path.join(fixtureDir, fixtureNames[index]), await png(svg))));
  await writeFile(path.join(dataDir, "model-reference.png"), await png(frame(`<circle cx="256" cy="182" r="63" fill="#c0aa8a"/><path d="M140 510V360Q256 253 372 360V510Z" fill="#606d73"/>`, "#ebe6dd")));
  try { await readFile(path.join(dataDir, "library.json")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const seeds = [];
    for (const [index, color] of ["#273d54", "#c4af89"].entries()) {
      const id = `import-${index ? "22222222" : "11111111"}-1111-4111-8111-111111111111`;
      const filename = `${id}-synthetic.png`;
      await writeFile(path.join(dataDir, "imported", filename), await png(frame(trousers(color), null)));
      seeds.push({ id, name: index ? "Beige Chinos" : "Dark Indigo Straight-leg Jeans", part: "lowerbody", color, secondaryColor: null, tags: ["32 x 32", "synthetic fixture"], canLayer: false, image: `/api/import/library/${filename}`, thumbnail: `/api/import/library/${filename}` });
    }
    await writeFile(path.join(dataDir, "library.json"), JSON.stringify(seeds, null, 2));
  }
  function respond(res, status, value) {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(value));
  }
  provider = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== "Bearer wardrobe-e2e-fixture-only") throw new Error("Unexpected fixture authorization");
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      if (req.url === "/v1/responses") {
        const request = JSON.parse(bytes.toString());
        const imageUrl = request.input[0].content.find((part) => part.type === "input_image").image_url;
        const pixels = await sharp(Buffer.from(imageUrl.split(",")[1], "base64")).ensureAlpha().raw().toBuffer();
        const index = pixels[0] === 235 ? 0 : pixels[0] === 245 ? 1 : pixels[0] === 228 ? 3 : 2;
        const names = ["Blue Flannel Shirt", "Rust Cotton Tee", "Formal Dress Shirt", "Olive Zip Jacket"];
        const item = { name: names[index], part: index === 3 ? "wholebody_up" : "upperbody", color: ["#436377", "#b56543", "#d2dfdc", "#60765d"][index], secondaryColor: index === 0 ? "#879aa8" : null, tags: [index === 0 ? "flannel" : index === 1 ? "cotton" : index === 3 ? "zip" : "formal"], canLayer: index === 0 || index === 3, boundingBox: { x: 150, y: 100, width: 700, height: 790 } };
        const schema = request.text.format.schema.properties.items.items;
        state.analysis.push({ name: item.name, part: item.part, canLayer: item.canLayer, schemaHasLayering: Boolean(schema.properties.canLayer), schemaHasShirt: Object.hasOwn(schema.properties, "isShirt") });
        return respond(res, 200, { output_text: JSON.stringify({ items: [item] }) });
      }
      if (req.url !== "/v1/images/edits") throw new Error("Unknown fixture provider route");
      const form = await new Response(bytes, { headers: { "Content-Type": req.headers["content-type"] } }).formData();
      const prompt = form.get("prompt");
      const files = form.getAll("image[]");
      for (const file of files) {
        if ((await sharp(Buffer.from(await file.arrayBuffer())).metadata()).format !== "png") throw new Error("Expected PNG references");
      }
      const mode = form.get("size") === "1024x1024" ? "garment" : /Use the featured garment as an OUTER LAYER/i.test(prompt) ? "layer" : "default";
      const name = /Olive Zip Jacket/.test(prompt) ? "Olive Zip Jacket" : /Blue Flannel Shirt/.test(prompt) ? "Blue Flannel Shirt" : /Rust Cotton Tee/.test(prompt) ? "Rust Cotton Tee" : "Formal Dress Shirt";
      state.edits.push({ mode, name, referenceCount: files.length, size: form.get("size"), thoughtfullyStyledInnerLayer: mode === "layer" && /T-shirt/i.test(prompt) && /hoodie/i.test(prompt) && /experienced.*menswear|menswear.*experienced/i.test(prompt) });
      let output;
      if (mode === "garment") {
        const key = prompt.match(/uniform solid (#[a-f0-9]{6}) chroma-key/i)?.[1];
        if (!key) throw new Error("No source chroma key");
        const body = /jacket/i.test(name) ? jacket : /flannel/i.test(name) ? shirt("#436377", true) : /tee/i.test(name) ? tee : shirt("#d2dfdc");
        output = await png(frame(body, key));
      } else output = await png(modeled(mode, name));
      return respond(res, 200, { data: [{ b64_json: output.toString("base64") }] });
    } catch (error) {
      state.errors.push(error.message);
      return respond(res, 500, { error: { message: error.message } });
    }
  });
  await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
  const env = {
    OPENAI_API_KEY: "wardrobe-e2e-fixture-only", OPENAI_API_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`,
    WARDROBE_DATA_DIR: dataDir, WARDROBE_MODEL_REFERENCE: path.join(dataDir, "model-reference.png"), WARDROBE_MODEL_DIRECTION: "Anonymous code-native fixture only",
    OPENAI_IMAGE_MODEL: "local-fixture", OPENAI_VISION_MODEL: "local-fixture", OPENAI_GARMENT_MODEL: "local-fixture", OPENAI_MODELED_MODEL: "local-fixture", OPENAI_IMAGE_QUALITY: "low",
  };
  const statusPlugin = { name: "local-e2e-status", configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url?.startsWith("/__e2e/inputs/")) {
        const name = req.url.slice("/__e2e/inputs/".length);
        if (!fixtureNames.includes(name)) return respond(res, 404, { error: "Unknown fixture" });
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
        return res.end(await readFile(path.join(fixtureDir, name)));
      }
      if (req.url !== "/__e2e") return next();
      const library = JSON.parse(await readFile(path.join(dataDir, "library.json"), "utf8"));
      const ids = await readdir(path.join(dataDir, "jobs")).catch(() => []);
      const jobs = await Promise.all(ids.map(async (id) => JSON.parse(await readFile(path.join(dataDir, "jobs", id, "job.json"), "utf8"))));
      return respond(res, 200, { ...state, counts: { analysis: state.analysis.length, garment: state.edits.filter((e) => e.mode === "garment").length, modeled: state.edits.filter((e) => e.mode !== "garment").length }, library, jobs: jobs.map(({ internal, ...job }) => job) });
    });
  } };
  vite = await createVite({ configFile: false, root: repo, envDir: work, publicDir: path.join(repo, "public"), plugins: [react(), statusPlugin, wardrobeImportApi({ env })], server: { host: "127.0.0.1", port: 5175, strictPort: true }, optimizeDeps: { include: ["react", "react-dom/client"] } });
  await vite.listen();
  console.log(JSON.stringify({ ready: true, url: "http://127.0.0.1:5175/", status: "http://127.0.0.1:5175/__e2e", fixtureOnly: true, fixtures: fixtureNames.map((name) => path.join(fixtureDir, name)) }));
} catch (error) {
  await cleanup();
  throw error;
}
