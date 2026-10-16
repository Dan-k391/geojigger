import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { RoundRecap, RoundResult } from './protocol';

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

/** End-of-game map: every round's true spot (numbered) with everyone's guesses. */
export class RecapMap {
  private map: L.Map;
  private layer = L.layerGroup();
  private roundBounds: L.LatLngBounds[] = [];
  private allBounds: L.LatLngBounds | null = null;
  private flags: HTMLElement[] = [];
  private selected: number | null = null;
  onSelect: (index: number) => void = () => {};

  /** `rightPad`: pixels of the map currently covered by a side panel, kept clear of markers. */
  constructor(
    el: HTMLElement,
    private rightPad: () => number = () => 0,
  ) {
    // flyToBounds needs a starting view to animate from.
    this.map = baseMap(el).setView([20, 0], 2);
    this.layer.addTo(this.map);
    // Re-frame after window resizes, rotation, or the layout switching to mobile.
    let timer: ReturnType<typeof setTimeout> | undefined;
    new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        this.map.invalidateSize();
        if (this.allBounds) this.focus(this.selected, false);
      }, 100);
    }).observe(el);
  }

  show(history: RoundRecap[]) {
    this.layer.clearLayers();
    this.roundBounds = [];
    this.allBounds = null;
    this.flags = [];
    this.map.invalidateSize();
    history.forEach((h, i) => {
      const target = L.latLng(h.loc.lat, h.loc.lng);
      const points = [target];
      for (const r of h.results) {
        if (!r.guess) continue;
        let lng = r.guess.lng;
        while (lng - target.lng > 180) lng -= 360;
        while (target.lng - lng > 180) lng += 360;
        const g = L.latLng(r.guess.lat, lng);
        points.push(g);
        L.polyline([g, target], { color: r.color, weight: 2, opacity: 0.7, dashArray: '5 6' }).addTo(this.layer);
        L.marker(g, { icon: pin(r.color, r.name.slice(0, 1).toUpperCase()) })
          .bindTooltip(`${r.name} · round ${h.round}`)
          .addTo(this.layer);
      }
      const marker = L.marker(target, {
        icon: L.divIcon({
          className: 'pin',
          html: `<div class="pin-round">${h.round}</div>`,
          iconSize: [30, 30],
          iconAnchor: [15, 15],
        }),
        zIndexOffset: 1000,
      })
        .on('click', () => this.onSelect(i))
        .addTo(this.layer);
      this.flags.push(marker.getElement()!);
      const bounds = L.latLngBounds(points);
      this.roundBounds.push(bounds);
      this.allBounds = this.allBounds ? this.allBounds.extend(bounds) : L.latLngBounds(points);
    });
    this.focus(null, false);
  }

  /** Zoom to one round (null = all rounds) and highlight its marker. */
  focus(index: number | null, animate = true) {
    this.selected = index;
    this.flags.forEach((f, i) => f?.firstElementChild?.classList.toggle('active', i === index));
    const bounds = index === null ? this.allBounds : this.roundBounds[index];
    if (!bounds) return;
    if (bounds.getNorthEast().equals(bounds.getSouthWest())) return void this.map.setView(bounds.getCenter(), 8);
    const options = { paddingTopLeft: [40, 40] as L.PointTuple, paddingBottomRight: [this.rightPad() + 40, 40] as L.PointTuple, maxZoom: 12 };
    if (animate) this.map.flyToBounds(bounds, { ...options, duration: 0.6 });
    else this.map.fitBounds(bounds, { ...options, animate: false });
  }
}
