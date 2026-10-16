// Human-readable place names for the recap, from OpenStreetMap's Nominatim.
// Its usage policy allows at most one request per second, so lookups are queued.

const cache = new Map<string, Promise<string | null>>();
let queue: Promise<unknown> = Promise.resolve();

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function lookup(lat: number, lng: number): Promise<string | null> {
  const url =
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10` +
    `&lat=${lat.toFixed(5)}&lon=${lng.toFixed(5)}&accept-language=en`; // match the English UI
  const res = await fetch(url);
  if (!res.ok) return null;
  const a = (await res.json()).address ?? {};
  const local = a.city ?? a.town ?? a.village ?? a.hamlet ?? a.municipality ?? a.county ?? a.state;
  return [local, a.country].filter(Boolean).join(', ') || null;
}

/** "Town, Country" for a point, or null if unknown or offline. */
export function placeName(id: string, lat: number, lng: number): Promise<string | null> {
  let p = cache.get(id);
  if (!p) {
    p = queue.then(() => lookup(lat, lng)).catch(() => null);
    queue = p.then(() => pause(1100));
    cache.set(id, p);
  }
  return p;
}
