import { CONSTANTS, Viewer } from '@photo-sphere-viewer/core';
import { MarkersPlugin } from '@photo-sphere-viewer/markers-plugin';
import '@photo-sphere-viewer/core/index.css';
import '@photo-sphere-viewer/markers-plugin/index.css';
import type { Loc, MoveMode } from './protocol';
import { angleDiff, findNeighbors, type Neighbor } from './imagery';

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const norm = (d: number) => ((d % 360) + 360) % 360;

const { ACTIONS } = CONSTANTS;

/**
 * 360° viewer with Street View-style driving: arrows on the road lead to the
 * next car picture in each direction; clicking the road or pressing ↑/↓ (W/S)
 * moves too. Pictures load in standard definition first, then upgrade to HD.
 */
export class Pano {
  private viewer: Viewer;
  private markers: MarkersPlugin;
  private start: Loc | null = null;
  private current: Loc | null = null;
  private mode: MoveMode = 'move';
  private hd = true;
  private token = 0;
  private abort: AbortController | null = null;
  private arrows: Neighbor[] = [];
  private blobUrl: string | null = null;
  private lastMarkerClick = 0;
  onHeading: (deg: number) => void = () => {};
  onError: (err: Error) => void = () => {};

  constructor(container: HTMLElement) {
    this.viewer = new Viewer({
      container,
      navbar: false,
      defaultZoomLvl: 0,
      loadingTxt: '',
      mousewheelCtrlKey: false,
      touchmoveTwoFingers: false,
      keyboard: false,
      keyboardActions: {
        ArrowLeft: ACTIONS.ROTATE_LEFT,
        ArrowRight: ACTIONS.ROTATE_RIGHT,
        a: ACTIONS.ROTATE_LEFT,
        d: ACTIONS.ROTATE_RIGHT,
        ArrowUp: () => this.drive(0),
        w: () => this.drive(0),
        ArrowDown: () => this.drive(180),
        s: () => this.drive(180),
        PageUp: ACTIONS.ZOOM_IN,
        PageDown: ACTIONS.ZOOM_OUT,
        '+': ACTIONS.ZOOM_IN,
        '=': ACTIONS.ZOOM_IN,
        '-': ACTIONS.ZOOM_OUT,
      },
      plugins: [[MarkersPlugin, {}]],
    });
    this.markers = this.viewer.getPlugin(MarkersPlugin) as MarkersPlugin;
    this.markers.addEventListener('select-marker', ({ marker }) => {
      this.lastMarkerClick = performance.now();
      const arrow = this.arrows.find((a) => a.loc.id === marker.id);
      // Keep facing the same compass direction after a step, like driving.
      if (arrow) void this.goTo(arrow.loc, this.worldYaw());
    });
    // Clicking the road below the horizon drives toward that spot.
    this.viewer.addEventListener('click', ({ data }) => {
      if (this.mode !== 'move' || data.rightclick || data.pitch > rad(-6)) return;
      setTimeout(() => {
        if (performance.now() - this.lastMarkerClick < 300) return; // the click hit an arrow
        this.moveToward(norm(deg(data.yaw) + (this.current?.heading ?? 0)), 45);
      });
    });
    this.viewer.addEventListener('position-updated', () => this.onHeading(this.worldYaw()));
    // PSV only listens to window resizes; also follow the container (screen switches, mobile toolbars).
    new ResizeObserver(() => this.viewer.autoSize()).observe(container);
    // A round that starts while the tab is in the background leaves a half-faded
    // frame on the canvas; redraw once the player comes back.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.viewer.autoSize();
        this.viewer.needsUpdate();
      }
    });
  }

  /** Current view direction in degrees clockwise from north. */
  private worldYaw(): number {
    return norm(deg(this.viewer.getPosition().yaw) + (this.current?.heading ?? 0));
  }

  async show(loc: Loc, mode: MoveMode) {
    this.start = loc;
    this.mode = mode;
    const locked = mode === 'nmpz';
    this.viewer.setOptions({ mousemove: !locked, mousewheel: !locked, keyboard: locked ? false : 'always' });
    // Face along the road (the car's heading) or the opposite way, as in Street View.
    const facing = locked ? loc.heading : loc.heading + (Math.random() < 0.5 ? 0 : 180);
    await this.goTo(loc, facing, false);
  }

  returnToStart() {
    if (this.start && this.current?.id !== this.start.id) void this.goTo(this.start, this.worldYaw());
  }

  setHd(on: boolean) {
    this.hd = on;
    if (this.current) void this.goTo(this.current, this.worldYaw(), false);
  }

  /** Drive forward (0) or backward (180) relative to where the player is looking. */
  private drive(relative: number) {
    if (this.mode === 'move') this.moveToward(norm(this.worldYaw() + relative), 60);
  }

  private moveToward(bearing: number, tolerance: number) {
    let best: Neighbor | null = null;
    for (const a of this.arrows) {
      const diff = angleDiff(a.bearing, bearing);
      if (diff <= tolerance && (!best || diff < angleDiff(best.bearing, bearing))) best = a;
    }
    if (best) void this.goTo(best.loc, this.worldYaw());
  }

  private async goTo(loc: Loc, facing: number, transition = true) {
    const token = ++this.token;
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    this.markers.clearMarkers();
    this.arrows = [];
    try {
      await this.viewer.setPanorama(loc.img, {
        position: { yaw: rad(facing - loc.heading), pitch: 0 },
        zoom: 0,
        transition: transition ? { speed: 350, rotation: false, effect: 'fade' } : false,
      });
    } catch (err) {
      if (token === this.token) this.onError(err as Error);
      return;
    }
    if (token !== this.token) return;
    this.current = loc;
    this.onHeading(this.worldYaw());
    if (this.mode === 'move') void this.placeArrows(loc, token, abort.signal);
    if (this.hd && loc.hd !== loc.img) void this.upgrade(loc, token, abort.signal);
  }

  /** Swap the SD picture for the full-resolution one once it has downloaded. */
  private async upgrade(loc: Loc, token: number, signal: AbortSignal) {
    try {
      const res = await fetch(loc.hd, { signal });
      if (!res.ok) return;
      const blob = await res.blob();
      if (token !== this.token) return;
      const url = URL.createObjectURL(blob);
      const old = this.blobUrl;
      this.blobUrl = url;
      await this.viewer.setPanorama(url, {
        position: this.viewer.getPosition(),
        zoom: this.viewer.getZoomLevel(),
        transition: false,
        showLoader: false,
      });
      if (old) URL.revokeObjectURL(old);
    } catch {
      // Aborted because the player moved on, or HD unavailable: keep SD.
    }
  }

  private async placeArrows(loc: Loc, token: number, signal: AbortSignal) {
    let arrows: Neighbor[];
    try {
      arrows = await findNeighbors(loc, signal);
    } catch {
      return; // aborted or offline: just no arrows
    }
    if (token !== this.token) return;
    this.arrows = arrows;
    for (const a of arrows) {
      this.markers.addMarker({
        id: a.loc.id,
        position: { yaw: rad(a.bearing - loc.heading), pitch: rad(-30) },
        html: '<div class="move-arrow"><svg viewBox="0 0 24 24"><path d="M4 16l8-8 8 8" /></svg></div>',
        size: { width: 56, height: 56 },
        anchor: 'center center',
      });
    }
  }

  clear() {
    this.token++;
    this.abort?.abort();
    this.arrows = [];
    this.markers.clearMarkers();
    this.viewer.setOptions({ keyboard: false });
  }
}
