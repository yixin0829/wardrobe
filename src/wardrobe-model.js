const MODES = new Set(["top", "layer", "default"]);

// A shirt stays a top even when it can also be worn over another top.
export function normalizeLayering(value = {}, existing = {}) {
  const part = value.part ?? existing.part;
  const manual = existing.layeringSource === "manual" && value.layeringSource !== "manual";
  const source = manual ? existing : { ...existing, ...value };
  const isShirt = part === "upperbody" && source.isShirt === true;
  return {
    isShirt,
    canLayer: isShirt && source.canLayer === true,
    layeringSource: source.layeringSource === "manual" ? "manual" : "ai",
  };
}

export function getExpectedModeledModes(item = {}) {
  const { isShirt, canLayer } = normalizeLayering(item);
  return canLayer ? ["top", "layer"] : [isShirt ? "top" : "default"];
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
