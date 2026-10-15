import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { RoundResult } from './protocol';

// Humanitarian OSM style: unlike the standard OSM style it draws country
// borders at every zoom level, which matters most when zoomed out to guess.
const TILES = 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png';
const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, style by <a href="https://www.hotosm.org/">HOT</a>, hosted by <a href="https://openstreetmap.fr/">OSM France</a>';

function baseMap(el: HTMLElement): L.Map {
  const map = L.map(el, { worldCopyJump: true, minZoom: 1, zoomSnap: 0.5 });
  // HOT's zoom-1 tiles have no borders yet, so fully zoomed out we draw its zoom-2 tiles scaled down.
  L.tileLayer(TILES, { subdomains: 'abc', minNativeZoom: 2, maxZoom: 19, attribution: ATTRIBUTION }).addTo(map);
  return map;
}

function pin(color: string, label = ''): L.DivIcon {
  return L.divIcon({
    className: 'pin',
    html: `<div class="pin-dot" style="background:${color}">${label}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

const flag = () =>
  L.divIcon({ className: 'pin', html: '<div class="pin-flag">⚑</div>', iconSize: [32, 32], iconAnchor: [8, 30] });

/** The small map players click to place their guess. */
export class GuessMap {
  readonly map: L.Map;
  private marker: L.Marker | null = null;
  private locked = false;
  color = '#22c55e';
  onChange: (pos: L.LatLng | null) => void = () => {};

  constructor(el: HTMLElement) {
    this.map = baseMap(el);
    this.map.on('click', (e: L.LeafletMouseEvent) => {
      if (this.locked) return;
      const pos = e.latlng.wrap();
      if (this.marker) this.marker.setLatLng(e.latlng);
      else this.marker = L.marker(e.latlng, { icon: pin(this.color) }).addTo(this.map);
      this.onChange(pos);
    });
  }

  private bounds: L.LatLngBoundsExpression | null = null;

  reset(bounds: L.LatLngBoundsExpression) {
    this.bounds = bounds;
    this.locked = false;
    this.marker?.remove();
    this.marker = null;
    this.map.invalidateSize();
    this.map.fitBounds(bounds);
    this.onChange(null);
  }

  /** Call after the container changes size; re-frames the region until a pin is placed. */
  resize() {
    this.map.invalidateSize();
    if (!this.marker && this.bounds) this.map.fitBounds(this.bounds);
  }

  lock() {
    this.locked = true;
  }

  get guess(): L.LatLng | null {
    return this.marker ? this.marker.getLatLng().wrap() : null;
  }
}

/** Map on the reveal screen: the true spot plus everyone's guesses. */
export class ResultMap {
  private map: L.Map;
  private layer = L.layerGroup();

  constructor(el: HTMLElement) {
    this.map = baseMap(el);
    this.layer.addTo(this.map);
  }

  /** `bottomPad`: pixels covered by the results panel, kept clear of markers. */
  show(actual: { lat: number; lng: number }, results: RoundResult[], bottomPad = 0) {
    this.layer.clearLayers();
    this.map.invalidateSize();
    const target = L.latLng(actual.lat, actual.lng);
    const points = [target];
    for (const r of results) {
      if (!r.guess) continue;
      // Draw toward the copy of the guess closest to the target, so lines don't
      // cross the whole map when the antimeridian is in between.
      let lng = r.guess.lng;
      while (lng - target.lng > 180) lng -= 360;
      while (target.lng - lng > 180) lng += 360;
      const g = L.latLng(r.guess.lat, lng);
      points.push(g);
      L.polyline([g, target], { color: r.color, weight: 2.5, dashArray: '6 6' }).addTo(this.layer);
      L.marker(g, { icon: pin(r.color, r.name.slice(0, 1).toUpperCase()) })
        .bindTooltip(r.name)
        .addTo(this.layer);
    }
    L.marker(target, { icon: flag(), zIndexOffset: 1000 }).addTo(this.layer);
    const bounds = points.length === 1 ? target.toBounds(400_000) : L.latLngBounds(points);
    this.map.fitBounds(bounds, { paddingTopLeft: [50, 50], paddingBottomRight: [50, bottomPad + 40], maxZoom: 14 });
  }

  invalidate() {
    this.map.invalidateSize();
  }
}
