// Street-level imagery from Panoramax (https://panoramax.fr), a federated, open
// (CC-BY-SA / Etalab) alternative to Street View. Its meta-catalogue API needs no key
// and sends CORS headers, so it can be queried straight from the browser.
import type { Loc } from './protocol';
import { bearing, haversine } from './geo';

const API = 'https://api.panoramax.xyz/api';

/** [minLng, minLat, maxLng, maxLat] */
type Box = [number, number, number, number];

export interface Region {
  id: string;
  name: string;
  boxes: { b: Box; w: number }[];
  /** Distance (km) at which the score falls to ~37% of the max. */
  scale: number;
}

// Rough land boxes, weighted by size and how much 360° imagery Panoramax has there.
const B = {
  wEurope: { b: [-10, 36, 20, 55], w: 10 },
  nEurope: { b: [4, 55, 31, 70], w: 3 },
  uk: { b: [-10.5, 50, 1.8, 58.7], w: 3 },
  eEurope: { b: [20, 41, 40, 55], w: 4 },
  usa: { b: [-124.5, 25, -67, 49], w: 8 },
  canada: { b: [-128, 43, -60, 56], w: 3 },
  mexico: { b: [-117, 14, -87, 32], w: 2 },
  centralAm: { b: [-92, 7, -77, 18], w: 1 },
  southAm: { b: [-81, -40, -35, 10], w: 5 },
  // Panoramax has almost no 360° car coverage in Africa yet; keep a token weight.
  nAfrica: { b: [-17, 20, 35, 37], w: 0.25 },
  wAfrica: { b: [-17, 4, 15, 16], w: 0.25 },
  eAfrica: { b: [28, -12, 45, 12], w: 0.25 },
  sAfrica: { b: [12, -35, 36, -15], w: 0.5 },
  middleEast: { b: [34, 12, 60, 40], w: 1.5 },
  russia: { b: [30, 50, 90, 62], w: 2 },
  centralAsia: { b: [50, 36, 85, 50], w: 1 },
  india: { b: [68, 8, 90, 30], w: 2 },
  china: { b: [100, 22, 122, 41], w: 1 },
  seAsia: { b: [95, -9, 125, 21], w: 3 },
  japan: { b: [129.5, 31, 146, 45], w: 3 },
  korea: { b: [126, 34, 129.6, 38.6], w: 1 },
  taiwan: { b: [120, 22, 122, 25.3], w: 1 },
  australia: { b: [114, -39, 154, -12], w: 3 },
  nz: { b: [166, -47, 179, -34], w: 1 },
} satisfies Record<string, { b: Box; w: number }>;

// Country regions are unions of boxes that stay inside the borders, so a
// "France" round never lands in England or Belgium.
const FRANCE: { b: Box; w: number }[] = [
  { b: [-1.2, 43.4, 7.0, 48.3], w: 8 },
  { b: [-4.8, 47.2, 1.5, 49.0], w: 3 },
  { b: [1.5, 48.3, 4.3, 50.3], w: 2 },
  { b: [1.6, 50.3, 2.6, 51.05], w: 0.5 },
  { b: [4.3, 47.4, 7.5, 49.0], w: 2 },
  { b: [-0.5, 42.9, 3.1, 43.4], w: 1 },
  { b: [3.0, 43.1, 7.5, 44.5], w: 2 },
];

const JAPAN: { b: Box; w: number }[] = [
  { b: [129.5, 30.9, 132.2, 34.0], w: 2 },
  { b: [130.8, 33.4, 136.0, 35.7], w: 3 },
  { b: [134.5, 33.4, 140.95, 37.0], w: 4 },
  { b: [138.3, 37.0, 142.1, 41.6], w: 3 },
  { b: [139.3, 41.3, 145.9, 45.6], w: 3 },
];

export const REGIONS: Region[] = [
  { id: 'world', name: 'World', boxes: Object.values(B), scale: 1500 },
  { id: 'europe', name: 'Europe', boxes: [B.wEurope, B.nEurope, B.uk, B.eEurope], scale: 450 },
  { id: 'france', name: 'France', boxes: FRANCE, scale: 120 },
  { id: 'namerica', name: 'North America', boxes: [B.usa, B.canada, B.mexico, B.centralAm], scale: 700 },
  { id: 'samerica', name: 'South America', boxes: [B.southAm], scale: 600 },
  {
    id: 'asia',
    name: 'Asia',
    boxes: [B.middleEast, B.russia, B.centralAsia, B.india, B.china, B.seAsia, B.japan, B.korea, B.taiwan],
    scale: 900,
  },
  { id: 'japan', name: 'Japan', boxes: JAPAN, scale: 180 },
  { id: 'oceania', name: 'Oceania', boxes: [B.australia, B.nz], scale: 450 },
];

export function getRegion(id: string): Region {
  return REGIONS.find((r) => r.id === id) ?? REGIONS[0];
}

/** [[south, west], [north, east]] covering every box of the region. */
export function regionBounds(region: Region): [[number, number], [number, number]] {
  const bs = region.boxes.map((x) => x.b);
  return [
    [Math.min(...bs.map((b) => b[1])), Math.min(...bs.map((b) => b[0]))],
    [Math.max(...bs.map((b) => b[3])), Math.max(...bs.map((b) => b[2]))],
  ];
}

interface Feature {
  id: string;
  collection: string;
  geometry: { coordinates: [number, number] };
  assets: Record<string, { href: string } | undefined>;
  providers?: { name: string }[];
  properties: Record<string, any>;
}

async function search(box: Box, limit: number, signal?: AbortSignal): Promise<Feature[]> {
  const bbox = box.map((n) => n.toFixed(6)).join(',');
  const url = `${API}/search?bbox=${bbox}&limit=${limit}&filter=${encodeURIComponent('field_of_view=360')}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Panoramax search failed (${res.status})`);
  const json = await res.json();
  return json.features ?? [];
}

function toLoc(f: Feature): Loc | null {
  const sd = f.assets.sd?.href;
  const status = f.properties['geovisio:status'];
  if (!sd || (status && status !== 'ready')) return null;
  const [lng, lat] = f.geometry.coordinates;
  return {
    id: f.id,
    collection: f.collection,
    lat,
    lng,
    img: sd,
    hd: f.assets.hd?.href ?? sd,
    heading: Number(f.properties['pers:yaw']) || 0,
    producer: f.providers?.map((p) => p.name).join(', ') || 'unknown',
    license: f.properties.license ?? '',
    date: f.properties.datetime ?? '',
  };
}

function weightedPick<T extends { w: number }>(items: T[]): T {
  let r = Math.random() * items.reduce((s, i) => s + i.w, 0);
  for (const item of items) if ((r -= item.w) <= 0) return item;
  return items[items.length - 1];
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

function intersect(a: Box, b: Box): Box | null {
  const r: Box = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return r[0] < r[2] && r[1] < r[3] ? r : null;
}

// ---------------------------------------------------------------- car filter

interface CollectionInfo {
  isCar: boolean;
}

const CAR_TRANSPORT = new Set(['car', 'van', 'truck', 'bus', 'vehicle', 'motor_vehicle', 'taxi']);
/** Average speed (km/h) above which an untagged sequence is assumed to be driven. */
const CAR_MIN_KMH = 30;

const collectionCache = new Map<string, Promise<CollectionInfo>>();

/**
 * Whether a sequence was shot from a car, like official Street View coverage.
 * Uses the uploader's `transport` tag when present, otherwise the average speed
 * (walking and cycling sequences stay well under 25 km/h, cars sit at 40+).
 * Single photospheres and short handheld sequences are rejected.
 */
function collectionInfo(id: string): Promise<CollectionInfo> {
  let p = collectionCache.get(id);
  if (!p) {
    p = fetch(`${API}/collections/${id}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((c): CollectionInfo => {
        const transport = (c.semantics ?? [])
          .find((x: { key: string }) => x.key === 'transport')
          ?.value?.trim()
          .toLowerCase();
        if (transport) return { isCar: CAR_TRANSPORT.has(transport) };
        const km = Number(c['geovisio:length_km']) || 0;
        const count = Number(c['stats:items']?.count) || 0;
        const [from, to] = c.extent?.temporal?.interval?.[0] ?? [];
        const hours = (Date.parse(to) - Date.parse(from)) / 3_600_000;
        if (count < 20 || km < 0.5 || !(hours > 0)) return { isCar: false };
        return { isCar: km / hours >= CAR_MIN_KMH };
      });
    // Don't cache network failures, so a later lookup can retry.
    p.catch(() => collectionCache.delete(id));
    collectionCache.set(id, p);
  }
  return p;
}

async function carCollections(ids: Iterable<string>): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  const verdicts = await Promise.all(unique.map((id) => collectionInfo(id).then((i) => i.isCar, () => false)));
  return new Set(unique.filter((_, i) => verdicts[i]));
}

// ---------------------------------------------------------------- locations

/** One dart: a random point in the region, then growing searches around it. */
async function tryDart(region: Region, avoid: Set<string>, signal: AbortSignal): Promise<Loc | null> {
  const { b } = weightedPick(region.boxes);
  const lng = rand(b[0], b[2]);
  const lat = rand(b[1], b[3]);
  for (const r of [1, 4]) {
    const box = intersect([lng - r, lat - r, lng + r, lat + r], b);
    if (!box) continue;
    const locs = (await search(box, 30, signal)).map(toLoc).filter((l): l is Loc => !!l && !avoid.has(l.collection));
    if (!locs.length || signal.aborted) continue;
    const cars = await carCollections(locs.map((l) => l.collection));
    const hits = locs.filter((l) => cars.has(l.collection));
    if (hits.length) return hits[Math.floor(Math.random() * hits.length)];
  }
  return null;
}

/**
 * Picks a random car-view panorama inside the region. Several darts fly in
 * parallel (most land on empty land or walking/cycling uploads); the first one
 * that finds a driven sequence wins and the rest are cancelled. `avoid` holds
 * collection (sequence) ids already used this game, so rounds don't repeat roads.
 */
export async function pickLocation(region: Region, avoid: Set<string>): Promise<Loc> {
  const ctrl = new AbortController();
  let found: Loc | null = null;
  let darts = 0;
  const worker = async () => {
    while (!found && darts++ < 60) {
      const loc = await tryDart(region, avoid, ctrl.signal).catch(() => null);
      if (loc && !found) {
        found = loc;
        ctrl.abort();
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (!found) throw new Error('Could not find any street imagery. Check your connection or try another region.');
  return found;
}

export interface Neighbor {
  loc: Loc;
  /** Degrees clockwise from north, as seen from the current panorama. */
  bearing: number;
  dist: number;
}

/** Smallest angle between two bearings, 0–180°. */
export const angleDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/**
 * Where you can drive to from here, like Street View's arrows: the nearest car
 * picture in each distinct direction (forward and back along the road, plus side
 * roads at junctions). Pictures from walking or cycling sequences are skipped.
 */
export async function findNeighbors(from: Loc, signal?: AbortSignal): Promise<Neighbor[]> {
  const d = 0.0005; // ~55 m
  const features = await search([from.lng - d, from.lat - d, from.lng + d, from.lat + d], 100, signal);
  const candidates: Neighbor[] = [];
  for (const f of features) {
    const loc = toLoc(f);
    if (!loc || loc.id === from.id) continue;
    const dist = haversine(from.lat, from.lng, loc.lat, loc.lng) * 1000;
    if (dist < 3 || dist > 45) continue;
    candidates.push({ loc, bearing: bearing(from.lat, from.lng, loc.lat, loc.lng), dist });
  }
  const cars = await carCollections(candidates.map((c) => c.loc.collection).filter((c) => c !== from.collection));
  cars.add(from.collection);
  const arrows: Neighbor[] = [];
  // Closest first; a farther picture only gets its own arrow if it points
  // somewhere clearly different (a crossing road rather than the same lane).
  candidates.sort((a, b) => a.dist - b.dist);
  for (const c of candidates) {
    if (!cars.has(c.loc.collection)) continue;
    if (arrows.every((a) => angleDiff(a.bearing, c.bearing) >= 50)) arrows.push(c);
    if (arrows.length >= 6) break;
  }
  return arrows;
}

