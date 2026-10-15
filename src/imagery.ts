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
  nAfrica: { b: [-17, 20, 35, 37], w: 1 },
  wAfrica: { b: [-17, 4, 15, 16], w: 1.5 },
  eAfrica: { b: [28, -12, 45, 12], w: 1.5 },
  sAfrica: { b: [12, -35, 36, -15], w: 2 },
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

export const REGIONS: Region[] = [
  { id: 'world', name: 'World', boxes: Object.values(B), scale: 1500 },
  { id: 'europe', name: 'Europe', boxes: [B.wEurope, B.nEurope, B.uk, B.eEurope], scale: 450 },
  { id: 'france', name: 'France', boxes: [{ b: [-4.8, 42.4, 8.2, 51.1], w: 1 }], scale: 120 },
  { id: 'namerica', name: 'North America', boxes: [B.usa, B.canada, B.mexico, B.centralAm], scale: 700 },
  { id: 'samerica', name: 'South America', boxes: [B.southAm], scale: 600 },
  { id: 'africa', name: 'Africa', boxes: [B.nAfrica, B.wAfrica, B.eAfrica, B.sAfrica], scale: 700 },
  {
    id: 'asia',
    name: 'Asia',
    boxes: [B.middleEast, B.russia, B.centralAsia, B.india, B.china, B.seAsia, B.japan, B.korea, B.taiwan],
    scale: 900,
  },
  { id: 'japan', name: 'Japan', boxes: [B.japan], scale: 180 },
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

/**
 * Picks a random 360° panorama inside the region: throw a dart, then search a
 * growing box around it until something turns up. `avoid` holds collection
 * (sequence) ids already used this game, so rounds don't land on the same road.
 */
export async function pickLocation(region: Region, avoid: Set<string>): Promise<Loc> {
  for (let attempt = 0; attempt < 25; attempt++) {
    const { b } = weightedPick(region.boxes);
    const lng = rand(b[0], b[2]);
    const lat = rand(b[1], b[3]);
    for (const r of [0.25, 1.5, 5]) {
      const box = intersect([lng - r, lat - r, lng + r, lat + r], b);
      if (!box) continue;
      let features: Feature[];
      try {
        features = await search(box, 40);
      } catch {
        continue; // transient network error: try another dart
      }
      const locs = features.map(toLoc).filter((l): l is Loc => !!l && !avoid.has(l.collection));
      if (!locs.length) continue;
      // Prefer pictures that belong to a sequence (several shots of the same
      // collection nearby), so there is somewhere to walk to.
      const perCollection = new Map<string, number>();
      for (const l of locs) perCollection.set(l.collection, (perCollection.get(l.collection) ?? 0) + 1);
      const walkable = locs.filter((l) => perCollection.get(l.collection)! >= 3);
      const pool = walkable.length ? walkable : locs;
      return pool[Math.floor(Math.random() * pool.length)];
    }
  }
  throw new Error('Could not find any imagery. Check your connection or try another region.');
}

export interface Neighbor {
  loc: Loc;
  /** Degrees clockwise from north, as seen from the current panorama. */
  bearing: number;
  dist: number;
}

/** Nearby panoramas to walk to, at most one per 45° sector (the closest). */
export async function findNeighbors(from: Loc, signal?: AbortSignal): Promise<Neighbor[]> {
  const d = 0.0007; // ~75 m
  const features = await search([from.lng - d, from.lat - d, from.lng + d, from.lat + d], 80, signal);
  const best = new Map<number, Neighbor>();
  for (const f of features) {
    const loc = toLoc(f);
    if (!loc || loc.id === from.id) continue;
    const dist = haversine(from.lat, from.lng, loc.lat, loc.lng) * 1000;
    if (dist < 2 || dist > 70) continue;
    const brg = bearing(from.lat, from.lng, loc.lat, loc.lng);
    const sector = Math.round(brg / 45) % 8;
    const cur = best.get(sector);
    if (!cur || dist < cur.dist) best.set(sector, { loc, bearing: brg, dist });
  }
  return [...best.values()];
}
