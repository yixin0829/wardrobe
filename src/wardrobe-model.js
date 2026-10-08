const MODES = new Set(["layer", "default"]);

// Wearing suitability is independent of the garment's category.
export function normalizeLayering(value = {}, existing = {}) {
  const manual = existing.layeringSource === "manual" && value.layeringSource !== "manual";
  const source = manual ? existing : { ...existing, ...value };
  return {
    canLayer: source.canLayer === true,
    layeringSource: source.layeringSource === "manual" ? "manual" : "ai",
  };
}

export function getExpectedModeledModes(item = {}) {
  return normalizeLayering(item).canLayer ? ["default", "layer"] : ["default"];
}

// Read old records into the current contract without replacing their assets.
export function normalizeWardrobeItem(value = {}) {
  const { isShirt: _obsolete, ...item } = value;
  return {
    ...item,
    ...normalizeLayering(item),
    ...(Array.isArray(item.modeledImages) ? { modeledImages: getModeledImages(item) } : {}),
    ...(item.modeledLayering ? { modeledLayering: normalizeLayering(item.modeledLayering) } : {}),
  };
}

export function getModeledImages(item = {}) {
  const images = Array.isArray(item.modeledImages) ? item.modeledImages : [];
  const seen = new Set();
  const normalized = images.flatMap((entry, index) => {
    if (!entry || typeof entry.image !== "string" || !entry.image.trim() || seen.has(entry.image)) return [];
    seen.add(entry.image);
    return [{
      id: typeof entry.id === "string" && entry.id ? entry.id : `modeled-${index + 1}`,
      mode: MODES.has(entry.mode) ? entry.mode : "default",
      image: entry.image,
    }];
  });
  if (normalized.length) return normalized;
  return typeof item.modeledImage === "string" && item.modeledImage
    ? [{ id: "modeled-default", mode: "default", image: item.modeledImage }]
    : [];
}
