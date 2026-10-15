// Messages exchanged over WebRTC data channels. The host is authoritative:
// clients only send intents (hello / guess / chat), the host owns all game state.

export type Phase = 'lobby' | 'loading' | 'round' | 'reveal' | 'final';
export type MoveMode = 'move' | 'nomove' | 'nmpz';

export interface Settings {
  rounds: number;
  /** Seconds per round, 0 = unlimited. */
  time: number;
  move: MoveMode;
  region: string;
}

export interface Loc {
  id: string;
  collection: string;
  lat: number;
  lng: number;
  /** Standard-definition equirectangular image (2048px wide). */
  img: string;
  /** Full-resolution image, much heavier. */
  hd: string;
  /** Camera heading of the image centre, degrees clockwise from north. */
  heading: number;
  producer: string;
  license: string;
  date: string;
}

export interface PlayerInfo {
  id: string;
  name: string;
  color: string;
  total: number;
  guessed: boolean;
  connected: boolean;
}

export interface RoundResult {
  id: string;
  name: string;
  color: string;
  guess: { lat: number; lng: number } | null;
  /** Kilometres, null when no guess was made. */
  dist: number | null;
  score: number;
  total: number;
}

export interface Standing {
  id: string;
  name: string;
  color: string;
  total: number;
  scores: number[];
}

export type HostMsg =
  | { t: 'state'; hostId: string; phase: Phase; settings: Settings; players: PlayerInfo[]; round: number }
  /** `remaining`: seconds left from the moment of sending, null when untimed. */
  | { t: 'round'; round: number; rounds: number; loc: Loc; remaining: number | null; move: MoveMode; region: string }
  /** The round clock changed, e.g. someone guessed and everyone else now has 15 s. */
  | { t: 'timer'; round: number; remaining: number; by: string /* player id */ }
  | { t: 'reveal'; round: number; rounds: number; loc: Loc; results: RoundResult[] }
  | { t: 'final'; standings: Standing[] }
  | { t: 'chat'; name: string; color: string; text: string }
  | { t: 'error'; text: string };

export type ClientMsg =
  | { t: 'hello'; name: string }
  | { t: 'guess'; round: number; lat: number; lng: number }
  | { t: 'chat'; text: string }
  // Host-only commands, ignored when sent by anyone else.
  | { t: 'settings'; settings: Settings }
  | { t: 'start' }
  | { t: 'next' }
  | { t: 'lobby' };
