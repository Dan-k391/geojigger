// WebRTC transport via PeerJS. The public PeerJS server is only used for the
// initial handshake (signalling); game traffic flows directly between browsers.
// Topology is a star: every client holds one data channel to the host.
import Peer, { type DataConnection } from 'peerjs';
import type { ClientMsg, HostMsg } from './protocol';

const PREFIX = 'geojigger-v1-';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomCode(len = 5): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function openPeer(id?: string): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const peer = id ? new Peer(id, { debug: 1 }) : new Peer({ debug: 1 });
    const fail = (err: Error) => {
      peer.destroy();
      reject(err);
    };
    peer.once('open', () => {
      peer.off('error', fail);
      // Losing the signalling server doesn't drop existing data channels; just reconnect.
      peer.on('disconnected', () => {
        if (!peer.destroyed) setTimeout(() => !peer.destroyed && peer.reconnect(), 1000);
      });
      resolve(peer);
    });
    peer.once('error', fail);
  });
}

export class HostNet {
  private conns = new Map<string, DataConnection>();
  onMessage: (from: string, msg: ClientMsg) => void = () => {};
  onLeave: (id: string) => void = () => {};

  private constructor(
    private peer: Peer,
    readonly code: string,
  ) {
    peer.on('connection', (conn) => {
      conn.on('open', () => {
        this.conns.get(conn.peer)?.close();
        this.conns.set(conn.peer, conn);
      });
      conn.on('data', (data) => this.onMessage(conn.peer, data as ClientMsg));
      const drop = () => {
        if (this.conns.get(conn.peer) !== conn) return;
        this.conns.delete(conn.peer);
        this.onLeave(conn.peer);
      };
      conn.on('close', drop);
      conn.on('error', drop);
    });
  }

  get id(): string {
    return this.peer.id;
  }

  /** Claims a fresh room code on the signalling server, retrying on collisions. */
  static async create(): Promise<HostNet> {
    for (let i = 0; i < 5; i++) {
      const code = randomCode();
      try {
        return new HostNet(await openPeer(PREFIX + code), code);
      } catch (err) {
        if ((err as { type?: string }).type !== 'unavailable-id') throw err;
      }
    }
    throw new Error('Could not allocate a room code');
  }

  send(to: string, msg: HostMsg) {
    const conn = this.conns.get(to);
    if (conn?.open) conn.send(msg);
  }

  broadcast(msg: HostMsg) {
    for (const conn of this.conns.values()) if (conn.open) conn.send(msg);
  }

  close() {
    this.peer.destroy();
  }
}

export class ClientNet {
  onMessage: (msg: HostMsg) => void = () => {};
  onClose: () => void = () => {};
  private closed = false;

  private constructor(
    private peer: Peer,
    private conn: DataConnection,
  ) {
    conn.on('data', (data) => this.onMessage(data as HostMsg));
    const end = () => {
      if (this.closed) return;
      this.closed = true;
      this.onClose();
    };
    conn.on('close', end);
    conn.on('error', end);
    // Data channel closes are sometimes not signalled; the ICE state is reliable.
    conn.peerConnection?.addEventListener('iceconnectionstatechange', () => {
      const s = conn.peerConnection?.iceConnectionState;
      if (s === 'failed' || s === 'closed') end();
    });
  }

  get id(): string {
    return this.peer.id;
  }

  static async connect(code: string, timeoutMs = 15000): Promise<ClientNet> {
    const peer = await openPeer();
    return new Promise((resolve, reject) => {
      const conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
      const timer = setTimeout(() => fail(new Error('Timed out connecting to host')), timeoutMs);
      function fail(err: Error) {
        clearTimeout(timer);
        peer.destroy();
        reject(err);
      }
      peer.on('error', (err) => {
        if ((err as { type?: string }).type === 'peer-unavailable') fail(new Error(`No game found with code ${code}`));
      });
      conn.once('open', () => {
        clearTimeout(timer);
        resolve(new ClientNet(peer, conn));
      });
    });
  }

  send(msg: ClientMsg) {
    if (this.conn.open) this.conn.send(msg);
  }

  close() {
    this.closed = true;
    this.peer.destroy();
  }
}
