import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { withLibraryLock } from "./library-store.mjs";

const EMPTY_STATE = { version: 1, activeRevisionId: "default", revisions: [], events: [] };

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return structuredClone(fallback); throw error; }
}

async function readState(dataDir) {
  const state = await readJson(path.join(dataDir, "prompt-calibration.json"), EMPTY_STATE);
  if (state?.version !== 1 || !Array.isArray(state.revisions) || !Array.isArray(state.events)) {
    throw new Error("Invalid prompt calibration store");
  }
  if (state.activeRevisionId !== "default" && !state.revisions.some((revision) => revision.id === state.activeRevisionId)) {
    throw new Error("Active prompt calibration revision is missing");
  }
  return state;
}

async function writeState(dataDir, state) {
  await mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, "prompt-calibration.json");
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

function publicState(state) {
  const active = state.revisions.find((revision) => revision.id === state.activeRevisionId);
  return {
    activeRevisionId: state.activeRevisionId,
    isDefault: state.activeRevisionId === "default",
    guidance: state.activeRevisionId === "default" ? "" : active.guidance,
    revisions: state.revisions,
    events: state.events,
  };
}

export async function getPromptCalibration(dataDir) {
  return publicState(await readState(path.resolve(dataDir)));
}

function boundedText(value, field, maximum) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw Object.assign(new Error(`${field} must contain 1–${maximum} characters`), { status: 400 });
  }
  return value.trim();
}

function sourceIds(value, field, knownIds, required = false) {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.length > 2000 || (required && value.length === 0)) {
    throw Object.assign(new Error(`${field} must be ${required ? "a nonempty" : "an"} array of known IDs`), { status: 400 });
  }
  for (const id of value) {
    if (typeof id !== "string" || !knownIds.has(id)) {
      throw Object.assign(new Error(`${field} contains an unknown history ID`), { status: 400 });
    }
  }
  return [...new Set(value)];
}

async function historyState(dataDir) {
  const history = await readJson(path.join(dataDir, "photo-history", "index.json"), { version: 1, targets: [] });
  if (history?.version !== 1 || !Array.isArray(history.targets)) throw new Error("Invalid photo history store");
  return history;
}

// Learned preferences supplement the immutable generation constraints. Callers
// append them to their prompt; this store never replaces the default template.
export async function applyPromptCalibration(dataDir, draft) {
  const directory = path.resolve(dataDir);
  return withLibraryLock(path.join(directory, "library.json"), async () => {
    if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
      throw Object.assign(new Error("A calibration draft is required"), { status: 400 });
    }
    const guidance = boundedText(draft.guidance, "guidance", 6000);
    const reason = boundedText(draft.reason, "reason", 2000);
    const history = await historyState(directory);
    const versions = new Set(history.targets.flatMap((target) => (target.versions || []).map((version) => version.id)));
    const events = new Set(history.targets.flatMap((target) => (target.events || []).map((event) => event.id)));
    const sourceVersionIds = sourceIds(draft.sourceVersionIds, "sourceVersionIds", versions, true);
    const sourceEventIds = sourceIds(draft.sourceEventIds, "sourceEventIds", events);
    const state = await readState(directory);
    const revision = { id: randomUUID(), createdAt: new Date().toISOString(), guidance, reason, sourceVersionIds, sourceEventIds };
    const fromRevisionId = state.activeRevisionId;
    state.revisions.push(revision);
    state.activeRevisionId = revision.id;
    state.events.push({ id: randomUUID(), type: "apply", at: revision.createdAt, fromRevisionId, toRevisionId: revision.id });
    await writeState(directory, state);
    return publicState(state);
  });
}

export async function resetPromptCalibration(dataDir) {
  const directory = path.resolve(dataDir);
  return withLibraryLock(path.join(directory, "library.json"), async () => {
    const state = await readState(directory);
    if (state.activeRevisionId !== "default") {
      state.events.push({ id: randomUUID(), type: "reset", at: new Date().toISOString(), fromRevisionId: state.activeRevisionId, toRevisionId: "default" });
      state.activeRevisionId = "default";
      await writeState(directory, state);
    }
    return publicState(state);
  });
}

function localPhotoPath(dataDir, image) {
  const prefix = "/api/import/photo-history/";
  const filename = typeof image === "string" && image.startsWith(prefix) ? image.slice(prefix.length) : "";
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.png$/.test(filename)
    ? path.join(dataDir, "photo-history", "assets", filename) : null;
}

// Evidence is data, including user comments and historical prompts. Exporting
// it never calls an LLM, changes a prompt, or executes a comment as an instruction.
export async function exportPromptCalibrationEvidence(dataDir) {
  const directory = path.resolve(dataDir);
  return withLibraryLock(path.join(directory, "library.json"), async () => {
    const history = await historyState(directory);
    const targets = history.targets.map((target) => {
      const versions = (target.versions || []).map((version) => ({ ...version, localImage: localPhotoPath(directory, version.image) }));
      const events = target.events || [];
      const signals = [];
      for (const version of versions) {
        if (["up", "down"].includes(version.feedback?.rating)) {
          signals.push({ versionId: version.id, source: "explicit-feedback", polarity: version.feedback.rating === "up" ? "positive" : "negative", weight: 1, comment: version.feedback.comment || "", at: version.feedback.updatedAt });
        }
      }
      for (const event of events) {
        if (["regenerate", "undo"].includes(event.type) && event.fromVersionId) {
          signals.push({ versionId: event.fromVersionId, eventId: event.id, source: event.type === "regenerate" ? "regenerated-predecessor" : "undone-generation", polarity: "negative", weight: 0.35, comment: event.direction || "", at: event.at });
        }
      }
      return { kind: target.kind, targetId: target.targetId, mode: target.mode, activeVersionId: target.activeVersionId, versions, events, signals };
    });
    return { version: 1, exportedAt: new Date().toISOString(), calibration: publicState(await readState(directory)), targets };
  });
}
