// Authoritative game logic. Runs only in the host's browser; the host's own UI
// talks to it through the same message types as remote players.
import type { ClientMsg, HostMsg, Loc, Phase, PlayerInfo, RoundResult, Settings, Standing } from './protocol';
import { getRegion, pickLocation } from './imagery';
import { haversine, score } from './geo';

const COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6', '#f97316', '#84cc16', '#6366f1'];

interface Player {
  id: string;
  name: string;
  color: string;
  connected: boolean;
  scores: number[];
}

/** `to === null` means broadcast to everyone, including the host's own UI. */
export type Send = (to: string | null, msg: HostMsg) => void;

/** Once someone guesses, everyone else has at most this long to follow. */
export const GUESS_COUNTDOWN = 15;

export const DEFAULT_SETTINGS: Settings = { rounds: 5, time: 120, move: 'move', region: 'world' };

export class HostGame {
  private players = new Map<string, Player>();
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private phase: Phase = 'lobby';
  private round = 0;
  private loc: Loc | null = null;
  private nextLoc: Promise<Loc> | null = null;
  private usedCollections = new Set<string>();
  private guesses = new Map<string, { lat: number; lng: number }>();
  /** When the round ends (ms, host clock), null for untimed rounds. */
  private deadline: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastReveal: HostMsg | null = null;
  private lastFinal: HostMsg | null = null;
  /** Bumped whenever the game restarts, so stale async round setups bail out. */
  private gen = 0;

  constructor(
    private hostId: string,
    private send: Send,
  ) {}

  handle(from: string, msg: ClientMsg) {
    switch (msg.t) {
      case 'hello':
        return this.join(from, msg.name);
      case 'guess':
        return this.guess(from, msg.round, msg.lat, msg.lng);
      case 'chat': {
        const p = this.players.get(from);
        const text = String(msg.text).trim().slice(0, 300);
        if (p && text) this.send(null, { t: 'chat', name: p.name, color: p.color, text });
        return;
      }
    }
    if (from !== this.hostId) return;
    switch (msg.t) {
      case 'settings':
        if (this.phase === 'lobby' || this.phase === 'final') {
          this.settings = sanitize(msg.settings);
          this.broadcastState();
        }
        return;
      case 'start':
        if (this.phase === 'lobby' || this.phase === 'final') this.startGame();
        return;
      case 'next':
        if (this.phase === 'reveal') this.round >= this.settings.rounds ? this.finish() : this.startRound();
        return;
      case 'lobby':
        if (this.phase !== 'lobby') {
          clearTimeout(this.timer);
          this.gen++;
          this.phase = 'lobby';
          for (const [id, p] of this.players) if (!p.connected) this.players.delete(id);
          this.broadcastState();
        }
        return;
    }
  }

  leave(id: string) {
    const p = this.players.get(id);
    if (!p) return;
    if (this.phase === 'lobby') this.players.delete(id);
    else p.connected = false;
    this.broadcastState();
    this.maybeEndRound();
  }

  private join(id: string, rawName: string) {
    const name = String(rawName).trim().slice(0, 20) || 'Player';
    let p = this.players.get(id);
    if (p) {
      p.name = name;
      p.connected = true;
    } else {
      const used = new Set([...this.players.values()].map((x) => x.color));
      const color = COLORS.find((c) => !used.has(c)) ?? COLORS[this.players.size % COLORS.length];
      // Late joiners get zeros for rounds already played so standings line up.
      const played = this.phase === 'lobby' ? 0 : this.round - (this.phase === 'round' || this.phase === 'loading' ? 1 : 0);
      p = { id, name, color, connected: true, scores: Array(Math.max(0, played)).fill(0) };
      this.players.set(id, p);
    }
    this.broadcastState();
    // Catch the newcomer up on whatever is on screen right now.
    if (this.phase === 'round') this.send(id, this.roundMsg());
    else if (this.phase === 'reveal' && this.lastReveal) this.send(id, this.lastReveal);
    else if (this.phase === 'final' && this.lastFinal) this.send(id, this.lastFinal);
  }

  private startGame() {
    clearTimeout(this.timer);
    this.gen++;
    for (const [id, p] of this.players) {
      if (!p.connected) this.players.delete(id);
      else p.scores = [];
    }
    this.round = 0;
    this.usedCollections.clear();
    this.nextLoc = this.prefetch();
    this.startRound();
  }

  private prefetch(): Promise<Loc> {
    const promise = pickLocation(getRegion(this.settings.region), this.usedCollections);
    promise.catch(() => {}); // handled when awaited in startRound
    return promise;
  }

  private async startRound() {
    const gen = this.gen;
    this.phase = 'loading';
    this.broadcastState();
    let loc: Loc;
    try {
      loc = await (this.nextLoc ?? this.prefetch());
    } catch (err) {
      if (gen !== this.gen) return;
      this.phase = 'lobby';
      this.broadcastState();
      this.send(null, { t: 'error', text: (err as Error).message });
      return;
    }
    if (gen !== this.gen) return; // host bailed to the lobby or restarted meanwhile
    this.usedCollections.add(loc.collection);
    this.loc = loc;
    this.round++;
    this.guesses.clear();
    this.phase = 'round';
    this.nextLoc = this.round < this.settings.rounds ? this.prefetch() : null;
    this.setDeadline(this.settings.time > 0 ? Date.now() + this.settings.time * 1000 : null);
    this.broadcastState();
    this.send(null, this.roundMsg());
  }

  private setDeadline(deadline: number | null) {
    this.deadline = deadline;
    clearTimeout(this.timer);
    // A little grace so guesses auto-submitted at 0:00 still arrive.
    if (deadline !== null) this.timer = setTimeout(() => this.endRound(), deadline - Date.now() + 2000);
  }

  private remaining(): number | null {
    return this.deadline === null ? null : Math.max(0, (this.deadline - Date.now()) / 1000);
  }

  private roundMsg(): HostMsg {
    return {
      t: 'round',
      round: this.round,
      rounds: this.settings.rounds,
      loc: this.loc!,
      remaining: this.remaining(),
      move: this.settings.move,
      region: this.settings.region,
    };
  }

  private guess(from: string, round: number, lat: number, lng: number) {
    if (this.phase !== 'round' || round !== this.round || this.guesses.has(from) || !this.players.has(from)) return;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90) return;
    this.guesses.set(from, { lat, lng: ((((lng + 180) % 360) + 360) % 360) - 180 });
    this.broadcastState();
    this.maybeEndRound();
    // First guess in: everyone else gets a short countdown (unless less time is left anyway).
    const left = this.remaining();
    if (this.phase === 'round' && (left === null || left > GUESS_COUNTDOWN)) {
      this.setDeadline(Date.now() + GUESS_COUNTDOWN * 1000);
      this.send(null, { t: 'timer', round: this.round, remaining: GUESS_COUNTDOWN, by: from });
    }
  }

  private maybeEndRound() {
    if (this.phase !== 'round') return;
    const active = [...this.players.values()].filter((p) => p.connected);
    if (active.every((p) => this.guesses.has(p.id))) this.endRound();
  }

  private endRound() {
    if (this.phase !== 'round' || !this.loc) return;
    clearTimeout(this.timer);
    const loc = this.loc;
    const scale = getRegion(this.settings.region).scale;
    const results: RoundResult[] = [...this.players.values()].map((p) => {
      const g = this.guesses.get(p.id) ?? null;
      const dist = g ? haversine(g.lat, g.lng, loc.lat, loc.lng) : null;
      const pts = dist === null ? 0 : score(dist, scale);
      p.scores.push(pts);
      return { id: p.id, name: p.name, color: p.color, guess: g, dist, score: pts, total: sum(p.scores) };
    });
    results.sort((a, b) => b.score - a.score);
    this.phase = 'reveal';
    this.lastReveal = { t: 'reveal', round: this.round, rounds: this.settings.rounds, loc, results };
    this.broadcastState();
    this.send(null, this.lastReveal);
  }

  private finish() {
    this.phase = 'final';
    const standings: Standing[] = [...this.players.values()]
      .map((p) => ({ id: p.id, name: p.name, color: p.color, total: sum(p.scores), scores: p.scores }))
      .sort((a, b) => b.total - a.total);
    this.lastFinal = { t: 'final', standings };
    this.broadcastState();
    this.send(null, this.lastFinal);
  }

  private broadcastState() {
    const players: PlayerInfo[] = [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      total: sum(p.scores),
      guessed: this.guesses.has(p.id),
      connected: p.connected,
    }));
    this.send(null, {
      t: 'state',
      hostId: this.hostId,
      phase: this.phase,
      settings: this.settings,
      players,
      round: this.round,
    });
  }
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function sanitize(s: Settings): Settings {
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number(n) || 0)));
  return {
    rounds: clamp(s.rounds, 1, 20),
    time: clamp(s.time, 0, 600),
    move: (['move', 'nomove', 'nmpz'] as const).includes(s.move) ? s.move : 'move',
    region: getRegion(s.region).id,
  };
}
