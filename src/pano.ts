import { Viewer } from '@photo-sphere-viewer/core';
import { MarkersPlugin } from '@photo-sphere-viewer/markers-plugin';
import '@photo-sphere-viewer/core/index.css';
import '@photo-sphere-viewer/markers-plugin/index.css';
import type { Loc, MoveMode } from './protocol';
import { findNeighbors } from './imagery';

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/**
 * 360° viewer with GeoGuessr-style movement: arrows on the ground lead to the
 * nearest Panoramax picture in each direction.
 */
export class Pano {
  private viewer: Viewer;
  private markers: MarkersPlugin;
  private start: Loc | null = null;
  private current: Loc | null = null;
  private mode: MoveMode = 'move';
  private hd = false;
  private token = 0;
  private abort: AbortController | null = null;
  private neighbors = new Map<string, Loc>();
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
      plugins: [[MarkersPlugin, {}]],
    });
    this.markers = this.viewer.getPlugin(MarkersPlugin) as MarkersPlugin;
    this.markers.addEventListener('select-marker', ({ marker }) => {
      const loc = this.neighbors.get(marker.id);
      // Keep facing the same compass direction after a step, like walking.
      if (loc) void this.goTo(loc, this.worldYaw());
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
    const yaw = deg(this.viewer.getPosition().yaw);
    return (((yaw + (this.current?.heading ?? 0)) % 360) + 360) % 360;
  }

  async show(loc: Loc, mode: MoveMode) {
    this.start = loc;
    this.mode = mode;
    const locked = mode === 'nmpz';
    this.viewer.setOptions({ mousemove: !locked, mousewheel: !locked, keyboard: locked ? false : 'fullscreen' });
    // Random initial facing so the first view isn't always along the road.
    await this.goTo(loc, locked ? loc.heading : Math.random() * 360, false);
  }

  returnToStart() {
    if (this.start && this.current?.id !== this.start.id) void this.goTo(this.start, this.worldYaw());
  }

  setHd(on: boolean) {
    this.hd = on;
    if (this.current) void this.goTo(this.current, this.worldYaw(), false);
  }

  get canMove() {
    return this.mode === 'move';
  }

  private async goTo(loc: Loc, facing: number, transition = true) {
    const token = ++this.token;
    this.abort?.abort();
    this.markers.clearMarkers();
    this.neighbors.clear();
    try {
      await this.viewer.setPanorama(this.hd ? loc.hd : loc.img, {
        position: { yaw: rad(facing - loc.heading), pitch: 0 },
        zoom: 0,
        transition: transition ? { speed: 400, rotation: false, effect: 'fade' } : false,
      });
    } catch (err) {
      if (token === this.token) this.onError(err as Error);
      return;
    }
    if (token !== this.token) return;
    this.current = loc;
    this.onHeading(this.worldYaw());
    if (this.mode === 'move') void this.placeArrows(loc, token);
  }

  private async placeArrows(loc: Loc, token: number) {
    this.abort = new AbortController();
    let neighbors;
    try {
      neighbors = await findNeighbors(loc, this.abort.signal);
    } catch {
      return; // aborted or offline: just no arrows
    }
    if (token !== this.token) return;
    for (const n of neighbors) {
      const id = `n-${n.loc.id}`;
      this.neighbors.set(id, n.loc);
      this.markers.addMarker({
        id,
        position: { yaw: rad(n.bearing - loc.heading), pitch: rad(-28) },
        html: '<div class="move-arrow"><svg viewBox="0 0 24 24"><path d="M4 16l8-8 8 8" /></svg></div>',
        size: { width: 56, height: 56 },
        anchor: 'center center',
        tooltip: `${Math.round(n.dist)} m`,
      });
    }
  }

  clear() {
    this.token++;
    this.abort?.abort();
    this.markers.clearMarkers();
  }
}
