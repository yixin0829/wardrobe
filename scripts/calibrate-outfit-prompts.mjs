#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyPromptCalibration, exportPromptCalibrationEvidence, getPromptCalibration, resetPromptCalibration } from "./prompt-calibration.mjs";
import { resolveWardrobeDataDir } from "./wardrobe-paths.mjs";

const usage = "Usage: node scripts/calibrate-outfit-prompts.mjs [--data <directory>] (--show | --export <file> | --apply <draft.json> | --reset)";

async function main(argv) {
  let dataDir = resolveWardrobeDataDir();
  let action;
  let file;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (["--help", "-h"].includes(argument)) { console.log(usage); return; }
    if (argument === "--data") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--data requires a directory");
      dataDir = path.resolve(value);
      continue;
    }
    if (!["--show", "--export", "--apply", "--reset"].includes(argument) || action) throw new Error(usage);
    action = argument;
    if (["--export", "--apply"].includes(action)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${action} requires a JSON file`);
      file = path.resolve(value);
    }
  }
  if (!action) throw new Error(usage);
  let result;
  if (action === "--show") result = await getPromptCalibration(dataDir);
  if (action === "--reset") result = await resetPromptCalibration(dataDir);
  if (action === "--apply") result = await applyPromptCalibration(dataDir, JSON.parse(await readFile(file, "utf8")));
  if (action === "--export") {
    result = await exportPromptCalibrationEvidence(dataDir);
    // A new destination avoids replacing a draft or another evidence export.
    await writeFile(file, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
    console.log(JSON.stringify({ exported: file, targets: result.targets.length }, null, 2));
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
