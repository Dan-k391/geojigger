import './style.css';
import { ClientNet, HostNet, normalizeCode } from './net';
import { HostGame } from './host';
import type { ClientMsg, HostMsg, PlayerInfo, Settings } from './protocol';
import { REGIONS, getRegion, regionBounds } from './imagery';
import { Pano } from './pano';
import { GuessMap, RecapMap, ResultMap } from './maps';
import { placeName } from './places';
import { formatDistance } from './geo';

type StateMsg = Extract<HostMsg, { t: 'state' }>;
type RoundMsg = Extract<HostMsg, { t: 'round' }>;
type RevealMsg = Extract<HostMsg, { t: 'reveal' }>;
type FinalMsg = Extract<HostMsg, { t: 'final' }>;

interface Session {
  myId: string;
  isHost: boolean;
  code: string;
  send(msg: ClientMsg): void;
  close(): void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Omit<HTMLElementTagNameMap[K], 'style'>> & { style?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { style, ...rest } = props;
  Object.assign(node, rest);
  if (style) node.setAttribute('style', style);
  node.append(...children);
  return node;
}

const swatch = (color: string) => el('span', { className: 'swatch', style: `background:${color}` });

let session: Session | null = null;
let state: StateMsg | null = null;
let round: RoundMsg | null = null;
let guessed = false;
let deadline = 0;
let timerHandle: ReturnType<typeof setInterval> | undefined;
let pano: Pano | null = null;
let guessMap: GuessMap | null = null;
let resultMap: ResultMap | null = null;
let hd = readPref('geojigger-hd', true);

function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

const SCREENS = ['home', 'lobby', 'game', 'reveal', 'final'] as const;
type Screen = (typeof SCREENS)[number];

function showScreen(name: Screen) {
  for (const s of SCREENS) $(`screen-${s}`).hidden = s !== name;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string, ms = 3500) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

const me = (): PlayerInfo | undefined => state?.players.find((p) => p.id === session?.myId);

// ---------------------------------------------------------------- home

const nameInput = $<HTMLInputElement>('name');
const codeInput = $<HTMLInputElement>('join-code');
const homeStatus = $('home-status');

try {
  nameInput.value = localStorage.getItem('geojigger-name') ?? '';
} catch {
  /* storage unavailable */
}
function codeFromHash() {
  const code = normalizeCode(location.hash.slice(1));
  if (code && !session) codeInput.value = code;
}
codeFromHash();
window.addEventListener('hashchange', codeFromHash);

function playerName(): string {
  const name = nameInput.value.trim() || 'Explorer';
  try {
    localStorage.setItem('geojigger-name', name);
  } catch {
    /* storage unavailable */
  }
  return name;
}

function setHomeBusy(busy: boolean, status = '') {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#screen-home button')) b.disabled = busy;
  homeStatus.textContent = status;
}

$('btn-create').addEventListener('click', async () => {
  setHomeBusy(true, 'Creating room…');
  let net: HostNet;
  try {
    net = await HostNet.create();
  } catch (err) {
    setHomeBusy(false, `Could not create room: ${(err as Error).message}`);
    return;
  }
  // Deliver host messages to our own UI asynchronously, in order, so UI handlers
  // that send commands never re-enter the game logic mid-update.
  const deliver = (msg: HostMsg) => queueMicrotask(() => onMessage(msg));
  const game = new HostGame(net.id, (to, msg) => {
    if (to === null) {
      net.broadcast(msg);
      deliver(msg);
    } else if (to === net.id) deliver(msg);
    else net.send(to, msg);
  });
  net.onMessage = (from, msg) => game.handle(from, msg);
  net.onLeave = (id) => game.leave(id);
  session = { myId: net.id, isHost: true, code: net.code, send: (msg) => game.handle(net.id, msg), close: () => net.close() };
  history.replaceState(null, '', `#${net.code}`);
  setHomeBusy(false);
  session.send({ t: 'hello', name: playerName() });
});

$('join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = normalizeCode(codeInput.value);
  if (!code) {
    homeStatus.textContent = 'Enter a room code first.';
    return;
  }
  setHomeBusy(true, 'Connecting…');
  let net: ClientNet;
  try {
    net = await ClientNet.connect(code);
  } catch (err) {
    setHomeBusy(false, (err as Error).message);
    return;
  }
  net.onMessage = onMessage;
  net.onClose = () => {
    if (session) {
      leave();
      toast('Lost connection to the host.', 5000);
    }
  };
  session = { myId: net.id, isHost: false, code, send: (msg) => net.send(msg), close: () => net.close() };
  history.replaceState(null, '', `#${code}`);
  setHomeBusy(false);
  session.send({ t: 'hello', name: playerName() });
});

function leave() {
  // A dropped client may want to rejoin the same room; a host's room is gone.
  if (session?.isHost) codeInput.value = '';
  session?.close();
  session = null;
  state = null;
  round = null;
  stopTimer();
  pano?.clear();
  $('chat-log').replaceChildren();
  history.replaceState(null, '', location.pathname + location.search);
  showScreen('home');
}

window.addEventListener('beforeunload', (e) => {
  if (session?.isHost && (state?.players.length ?? 0) > 1) e.preventDefault();
});

// ---------------------------------------------------------------- messages

function onMessage(msg: HostMsg) {
  if (!session) return;
  switch (msg.t) {
    case 'state':
      return onState(msg);
    case 'round':
      return onRound(msg);
    case 'timer':
      return onTimer(msg);
    case 'reveal':
      return onReveal(msg);
    case 'final':
      return onFinal(msg);
    case 'chat':
      return onChat(msg);
    case 'error':
      return toast(msg.text, 6000);
  }
}

function onState(msg: StateMsg) {
  state = msg;
  renderLobby();
  renderHudPlayers();
  if (msg.phase === 'lobby') {
    stopTimer();
    pano?.clear();
    showScreen('lobby');
  } else if (msg.phase === 'loading') {
    stopTimer();
    showScreen('game');
    $('loading').hidden = false;
    $('loading-text').textContent = msg.round === 0 ? 'Finding a place on Earth…' : 'Finding the next place…';
  }
}

// ---------------------------------------------------------------- lobby

const setRegion = $<HTMLSelectElement>('set-region');
const setRounds = $<HTMLSelectElement>('set-rounds');
const setTime = $<HTMLSelectElement>('set-time');
const setMove = $<HTMLSelectElement>('set-move');
const settingInputs = [setRegion, setRounds, setTime, setMove];

for (const r of REGIONS) setRegion.append(el('option', { value: r.id, textContent: r.name }));

function readSettings(): Settings {
  return {
    region: setRegion.value,
    rounds: Number(setRounds.value),
    time: Number(setTime.value),
    move: setMove.value as Settings['move'],
  };
}

function selectValue(select: HTMLSelectElement, value: string) {
  if (![...select.options].some((o) => o.value === value)) select.append(el('option', { value, textContent: value }));
  select.value = value;
}

for (const input of settingInputs) {
  input.addEventListener('change', () => session?.isHost && session.send({ t: 'settings', settings: readSettings() }));
}

function renderLobby() {
  if (!state || !session) return;
  $('room-code').textContent = session.code;
  const list = $('lobby-players');
  list.replaceChildren(
    ...state.players
      .filter((p) => p.connected)
      .map((p) =>
        el(
          'li',
          {},
          swatch(p.color),
          el('span', { textContent: p.name + (p.id === session!.myId ? ' (you)' : '') }),
          ...(p.id === state!.hostId ? [el('span', { className: 'tag', textContent: 'host' })] : []),
        ),
      ),
  );
  const s = state.settings;
  selectValue(setRegion, s.region);
  selectValue(setRounds, String(s.rounds));
  selectValue(setTime, String(s.time));
  selectValue(setMove, s.move);
  for (const input of settingInputs) input.disabled = !session.isHost;
  $('btn-start').hidden = !session.isHost;
  $('lobby-wait').hidden = session.isHost;
}

$('btn-start').addEventListener('click', () => session?.send({ t: 'start' }));
$('btn-leave').addEventListener('click', leave);
$('btn-copy').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}#${session?.code ?? ''}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('Invite link copied!');
  } catch {
    toast(url, 8000);
  }
});

$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('chat-input');
  const text = input.value.trim();
  if (text) session?.send({ t: 'chat', text });
  input.value = '';
});

function onChat(msg: Extract<HostMsg, { t: 'chat' }>) {
  const log = $('chat-log');
  log.append(el('li', {}, el('b', { style: `color:${msg.color}`, textContent: msg.name + ': ' }), msg.text));
  log.scrollTop = log.scrollHeight;
}

// ---------------------------------------------------------------- round

const guessBtn = $<HTMLButtonElement>('btn-guess');
const guessPanel = $('guess-panel');
const mapToggle = $('btn-map');

function ensureGameWidgets() {
  if (!pano) {
    pano = new Pano($('pano'));
    const needle = $('compass-needle');
    pano.onHeading = (d) => (needle.style.transform = `rotate(${-d}deg)`);
    pano.onError = () => toast('Could not load this panorama. Try the HD toggle or wait for the round to end.', 6000);
    pano.setHd(hd);
  }
  if (!guessMap) {
    guessMap = new GuessMap($('guess-map'));
    guessMap.onChange = (pos) => {
      if (guessed) return;
      guessBtn.disabled = !pos;
      guessBtn.textContent = pos ? 'Guess' : 'Place your pin';
    };
    guessPanel.addEventListener('transitionend', () => guessMap?.map.invalidateSize());
  }
}

function onRound(msg: RoundMsg) {
  round = msg;
  guessed = false;
  showScreen('game');
  $('loading').hidden = true;
  ensureGameWidgets();
  $('hud-round').textContent = `${msg.round} / ${msg.rounds}`;
  $('hud-score').textContent = (me()?.total ?? 0).toLocaleString();
  $('btn-return').hidden = msg.move !== 'move';
  guessPanel.classList.remove('open', 'guessed');
  mapToggle.classList.remove('open');
  mapToggle.textContent = 'Map';
  void pano!.show(msg.loc, msg.move);
  guessMap!.color = me()?.color ?? '#22c55e';
  guessMap!.reset(regionBounds(getRegion(msg.region)));
  startTimer(msg.remaining);
}

function onTimer(msg: Extract<HostMsg, { t: 'timer' }>) {
  if (msg.round !== round?.round) return;
  startTimer(msg.remaining);
  if (msg.by === session?.myId) return toast(`Everyone else now has ${msg.remaining} seconds!`);
  const name = state?.players.find((p) => p.id === msg.by)?.name ?? 'Someone';
  if (!guessed) toast(`${name} guessed — ${msg.remaining} seconds left!`);
}

function submitGuess() {
  const g = guessMap?.guess;
  if (!g || guessed || !round || !session) return;
  guessed = true;
  guessMap!.lock();
  guessPanel.classList.add('guessed');
  session.send({ t: 'guess', round: round.round, lat: g.lat, lng: g.lng });
  guessBtn.disabled = true;
  guessBtn.textContent = 'Waiting for others…';
}

guessBtn.addEventListener('click', submitGuess);
document.addEventListener('keydown', (e) => {
  if (e.key === ' ' && !$('screen-game').hidden && !guessBtn.disabled && document.activeElement?.tagName !== 'INPUT') {
    e.preventDefault();
    submitGuess();
  }
});

mapToggle.addEventListener('click', () => {
  const open = guessPanel.classList.toggle('open');
  mapToggle.classList.toggle('open', open);
  mapToggle.textContent = open ? 'Close' : 'Map';
  requestAnimationFrame(() => guessMap?.resize());
});

$('btn-return').addEventListener('click', () => pano?.returnToStart());
$('btn-exit').addEventListener('click', () => {
  const warning = session?.isHost ? 'Leave? You are the host, so this ends the game for everyone.' : 'Leave this game?';
  if (confirm(warning)) leave();
});
const hdBtn = $('btn-hd');
hdBtn.classList.toggle('on', hd);
hdBtn.addEventListener('click', () => {
  hd = !hd;
  writePref('geojigger-hd', hd);
  hdBtn.classList.toggle('on', hd);
  pano?.setHd(hd);
});

// Guess map: drag the corner handle to resize it (remembered), pin to keep it open.
const pinBtn = $('btn-pin');
function setMapSize(w: number, h: number) {
  guessPanel.style.setProperty('--map-w', `${Math.round(w)}px`);
  guessPanel.style.setProperty('--map-h', `${Math.round(h)}px`);
}
const savedSize = readPref<[number, number] | null>('geojigger-map-size', null);
if (savedSize) setMapSize(...savedSize);
guessPanel.classList.toggle('pinned', readPref('geojigger-map-pinned', false));
pinBtn.classList.toggle('on', guessPanel.classList.contains('pinned'));
pinBtn.addEventListener('click', () => {
  const pinned = guessPanel.classList.toggle('pinned');
  pinBtn.classList.toggle('on', pinned);
  writePref('geojigger-map-pinned', pinned);
});

const resizeHandle = $('map-resize');
resizeHandle.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  resizeHandle.setPointerCapture(e.pointerId);
  const rect = guessPanel.getBoundingClientRect();
  const start = { x: e.clientX, y: e.clientY, w: rect.width, h: rect.height };
  let size: [number, number] = [rect.width, rect.height];
  guessPanel.classList.add('resizing');
  let frame = 0;
  const move = (ev: PointerEvent) => {
    // The panel is anchored bottom-right, so dragging up/left grows it.
    size = [
      Math.min(innerWidth - 32, Math.max(260, start.w + start.x - ev.clientX)),
      Math.min(innerHeight - 32, Math.max(200, start.h + start.y - ev.clientY)),
    ];
    setMapSize(...size);
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => guessMap?.map.invalidateSize());
  };
  const end = () => {
    resizeHandle.removeEventListener('pointermove', move);
    resizeHandle.removeEventListener('pointerup', end);
    resizeHandle.removeEventListener('pointercancel', end);
    guessPanel.classList.remove('resizing');
    writePref('geojigger-map-size', size);
    guessMap?.resize();
  };
  resizeHandle.addEventListener('pointermove', move);
  resizeHandle.addEventListener('pointerup', end);
  resizeHandle.addEventListener('pointercancel', end);
});

function startTimer(remaining: number | null) {
  stopTimer();
  const box = $('hud-timer-box');
  box.hidden = remaining === null;
  if (remaining === null) return;
  deadline = Date.now() + remaining * 1000;
  const tick = () => {
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    $('hud-timer').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    box.classList.toggle('low', left <= 15);
    if (left === 0) {
      stopTimer();
      if (!guessed) {
        if (guessMap?.guess) submitGuess();
        else {
          guessed = true;
          guessMap?.lock();
          guessBtn.disabled = true;
          guessBtn.textContent = "Time's up";
        }
      }
    }
  };
  tick();
  timerHandle = setInterval(tick, 250);
}

function stopTimer() {
  clearInterval(timerHandle);
}

function renderHudPlayers() {
  if (!state) return;
  $('hud-players').replaceChildren(
    ...state.players.map((p) =>
      el(
        'li',
        { className: `${p.guessed ? 'done' : ''} ${p.connected ? '' : 'gone'}` },
        swatch(p.color),
        `${p.name}${p.id === session?.myId ? ' (you)' : ''}`,
      ),
    ),
  );
}

// ---------------------------------------------------------------- reveal

function onReveal(msg: RevealMsg) {
  stopTimer();
  pano?.clear();
  showScreen('reveal');

  const mine = msg.results.find((r) => r.id === session?.myId);
  $('reveal-title').textContent =
    mine?.dist != null ? `${formatDistance(mine.dist)} away · ${mine.score.toLocaleString()} pts` : `Round ${msg.round} results`;
  const sub = $('reveal-sub');
  const date = msg.loc.date ? new Date(msg.loc.date).toLocaleDateString() : '';
  sub.replaceChildren(
    `Round ${msg.round} of ${msg.rounds} · `,
    el('a', {
      href: `https://www.openstreetmap.org/?mlat=${msg.loc.lat}&mlon=${msg.loc.lng}#map=16/${msg.loc.lat}/${msg.loc.lng}`,
      target: '_blank',
      rel: 'noopener',
      textContent: 'view on OpenStreetMap',
    }),
    ` · 📷 ${msg.loc.producer}${date ? `, ${date}` : ''}${msg.loc.license ? ` (${msg.loc.license})` : ''}`,
  );

  $('reveal-body').replaceChildren(
    ...msg.results.map((r, i) =>
      el(
        'tr',
        { className: r.id === session?.myId ? 'me' : '' },
        el('td', { textContent: String(i + 1) }),
        el('td', {}, swatch(r.color), ' ', r.name),
        el('td', { textContent: r.dist == null ? '—' : formatDistance(r.dist) }),
        el('td', { textContent: r.score.toLocaleString() }),
        el('td', { textContent: r.total.toLocaleString() }),
      ),
    ),
  );

  const isHost = !!session?.isHost;
  const next = $('btn-next');
  next.hidden = !isHost;
  next.textContent = msg.round >= msg.rounds ? 'See final results' : 'Next round';
  $('reveal-wait').hidden = isHost;

  resultMap ??= new ResultMap($('result-map'));
  resultMap.show(msg.loc, msg.results, document.querySelector<HTMLElement>('.result-panel')!.offsetHeight + 16);
}

$('btn-next').addEventListener('click', () => session?.send({ t: 'next' }));

// ---------------------------------------------------------------- final

const MEDALS = ['🥇', '🥈', '🥉'];
let recapMap: RecapMap | null = null;
let recapRows: HTMLElement[] = [];

function selectRound(index: number | null) {
  recapRows.forEach((row, i) => row.classList.toggle('active', i === index));
  if (index !== null) recapRows[index]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  recapMap?.focus(index);
}

function onFinal(msg: FinalMsg) {
  showScreen('final');
  const { standings, history } = msg;

  $('final-list').replaceChildren(
    ...standings.map((s, i) => {
      // Per-player stats over the rounds they actually guessed in.
      const dists = history.map((h) => h.results.find((r) => r.id === s.id)?.dist).filter((d): d is number => d != null);
      const avg = dists.length ? dists.reduce((a, b) => a + b, 0) / dists.length : null;
      const best = Math.max(0, ...s.scores);
      const stats = [avg === null ? 'no guesses' : `avg ${formatDistance(avg)}`, `best ${best.toLocaleString()}`].join(' · ');
      return el(
        'li',
        { className: s.id === session?.myId ? 'me' : '' },
        el('span', { className: 'place', textContent: MEDALS[i] ?? String(i + 1) }),
        el(
          'div',
          {},
          el('div', {}, swatch(s.color), ' ', el('b', { textContent: s.name + (s.id === session?.myId ? ' (you)' : '') })),
          el('div', { className: 'rounds', textContent: stats }),
        ),
        el('span', { className: 'pts', textContent: s.total.toLocaleString() }),
      );
    }),
  );

  recapRows = history.map((h, i) => {
    const title = el('b', { textContent: `Round ${h.round}` });
    void placeName(h.loc.id, h.loc.lat, h.loc.lng).then((name) => name && (title.textContent = name));
    const top = Math.max(...h.results.map((r) => r.score));
    const cells = h.results.flatMap((r) => [
      swatch(r.color),
      el('span', { textContent: r.name }),
      el('span', { className: 'dist', textContent: r.dist == null ? 'no guess' : formatDistance(r.dist) }),
      el('span', {
        className: `pts${r.score === top && top > 0 ? ' best' : ''}`,
        textContent: (r.score === top && top > 0 ? '★ ' : '') + r.score.toLocaleString(),
      }),
    ]);
    const row = el(
      'li',
      { className: 'recap-round' },
      el(
        'div',
        { className: 'recap-title' },
        el('span', { className: 'round-no', textContent: String(h.round) }),
        title,
        el('a', {
          href: `https://www.openstreetmap.org/?mlat=${h.loc.lat}&mlon=${h.loc.lng}#map=16/${h.loc.lat}/${h.loc.lng}`,
          target: '_blank',
          rel: 'noopener',
          textContent: 'map ↗',
          title: 'Open this spot on OpenStreetMap',
        }),
      ),
      el('div', { className: 'recap-results' }, ...cells),
    );
    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('a')) return;
      selectRound(row.classList.contains('active') ? null : i);
    });
    return row;
  });
  $('recap-rounds').replaceChildren(...recapRows);

  const isHost = !!session?.isHost;
  $('btn-again').hidden = !isHost;
  $('btn-to-lobby').hidden = !isHost;
  $('final-wait').hidden = isHost;

  if (!recapMap) {
    // On wide screens the panel floats over the right of the map; keep markers clear of it.
    const panel = document.querySelector<HTMLElement>('.recap-panel')!;
    recapMap = new RecapMap($('recap-map'), () =>
      getComputedStyle(panel).position === 'absolute' ? panel.offsetWidth + 16 : 0,
    );
    recapMap.onSelect = (i) => selectRound(i);
  }
  recapMap.show(history);
}

$('btn-all-rounds').addEventListener('click', () => selectRound(null));
$('btn-again').addEventListener('click', () => session?.send({ t: 'start' }));
$('btn-to-lobby').addEventListener('click', () => session?.send({ t: 'lobby' }));
$('btn-quit').addEventListener('click', leave);
