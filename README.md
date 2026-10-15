# GeoJigger

A GeoGuessr-style geography game that runs entirely in the browser. There is no game server:
players connect to each other directly over WebRTC, and the street-level imagery comes
straight from the open [Panoramax](https://panoramax.fr) API. Build it once and host the
static files anywhere (GitHub Pages, Netlify, an S3 bucket, `python -m http.server`…).

## Play

1. One player clicks **Create a game** and shares the room code or invite link.
2. Friends open the link (or type the code) and click **Join**.
3. The host picks the region, rounds, time limit and mode, then starts.
4. Look around the 360° panorama, walk with the arrows on the ground, then drop a pin
   on the map and hit **Guess** (or press Space). Up to 5,000 points per round.

Modes: **Moving** (walk along the image sequence), **No move** (look around only),
**NMPZ** (no moving, panning or zooming).

## Develop

```bash
npm install
```

```bash
npm run dev
```

```bash
npm run build
```

`npm run build` type-checks and writes a static site to `dist/` with relative paths, so it
works from any subdirectory.

### Deploy

Pushes to `main` are built and published to GitHub Pages by
[.github/workflows/deploy.yml](.github/workflows/deploy.yml). One-time setup: in the repo's
**Settings → Pages**, set **Source** to **GitHub Actions**.

## How it works

| Piece | Choice |
| --- | --- |
| Networking | [PeerJS](https://peerjs.com) (WebRTC data channels). The free public PeerJS server is used only for the initial handshake; all game traffic is peer to peer. |
| Topology | Star: the host's browser runs the authoritative game logic ([src/host.ts](src/host.ts)); clients send only intents (join, guess, chat). The host's own UI talks to it with the same messages ([src/protocol.ts](src/protocol.ts)). |
| Imagery | Panoramax 360° pictures, searched by bounding box with no API key ([src/imagery.ts](src/imagery.ts)). The host picks each location and prefetches the next one during the round. |
| Panorama | [Photo Sphere Viewer](https://photo-sphere-viewer.js.org) plus its markers plugin for the movement arrows ([src/pano.ts](src/pano.ts)). |
| Map | [Leaflet](https://leafletjs.com) with OpenStreetMap tiles ([src/maps.ts](src/maps.ts)). |
| Scoring | `5000 · e^(−distance / scale)`, where the scale depends on the region size (1,500 km for the world). |

### Limitations

- Game state lives in the host's tab: if the host closes it, the game ends.
- Each client receives the round's coordinates (it needs them to find nearby pictures to walk
  to), so a determined player could cheat with the dev tools. It's a game for friends.
- Very strict NATs or firewalls can block WebRTC; PeerJS falls back to its public TURN relay
  where it can.
- Panoramax coverage is densest in Europe (especially France), so "World" rounds lean that way.

## Credits

Imagery © [Panoramax](https://panoramax.fr) contributors (CC-BY-SA / Etalab licences; the
photographer and licence are shown after each round). Map data ©
[OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
