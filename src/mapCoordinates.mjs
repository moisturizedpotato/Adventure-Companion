export function parseMapCoordinates(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;

  let match = text.match(/^\s*(-?\d{1,3}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  if (!match) {
    try {
      const url = new URL(text);
      const latitude = url.searchParams.get("mlat");
      const longitude = url.searchParams.get("mlon");
      if (latitude && longitude) match = [text, latitude, longitude];
      else match = url.hash.match(/#map=\d+(?:\.\d+)?\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/);
    } catch {
      return null;
    }
  }

  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}
