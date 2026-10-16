# GeoJigger

A GeoGuessr-style geography game that runs entirely in the browser. There is no game server:
players connect to each other directly over WebRTC, and the street-level imagery comes
straight from the open [Panoramax](https://panoramax.fr) API. Build it once and host the
static files anywhere (GitHub Pages, Netlify, an S3 bucket, `python -m http.server`…).

## Play

1. One player clicks **Create a game** and shares the room code or invite link.
2. Friends open the link (or type the code) and click **Join**.
3. The host picks the region, rounds, time limit and mode, then starts.
4. Look around the 360° panorama and drive along the road, then drop a pin on the map
   and hit **Guess** (or press Space). Up to 5,000 points per round.
5. As soon as anyone guesses, everyone else has **15 seconds** left.
6. After the last round, the **game recap** shows every location and everyone's guesses on
   one map, with each round's place name, distances, points and winner. Click a round to
   zoom to it.

Like GeoGuessr, every location is car-mounted street-level imagery: walking, cycling and
handheld photosphere uploads are filtered out.

Controls: click the arrows or the road to move, or use **↑/W** and **↓/S**; **←/→** turn.
Hover the map to expand it, drag its top-left corner to resize it, and pin it to keep it
open (size and pin are remembered). Pictures load fast in standard definition, then
sharpen to HD; the **HD** button turns that off on slow connections.

Modes: **Moving** (drive along the road), **No move** (look around only),
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
| Imagery | Panoramax 360° pictures, searched by bounding box with no API key ([src/imagery.ts](src/imagery.ts)). A sequence counts as a car view if its uploader tagged it `transport=car`, or if it averages over 30 km/h. The host throws several random "darts" in parallel, keeps the first car view found, and prefetches the next round's location. |
| Panorama | [Photo Sphere Viewer](https://photo-sphere-viewer.js.org) plus its markers plugin for the movement arrows ([src/pano.ts](src/pano.ts)). |
| Map | [Leaflet](https://leafletjs.com) with the Humanitarian OpenStreetMap style, which shows country borders at every zoom ([src/maps.ts](src/maps.ts)). |
| Scoring | `5000 · e^(−distance / scale)`, where the scale depends on the region size (1,500 km for the world). |

### Limitations

- Game state lives in the host's tab: if the host closes it, the game ends.
- Each client receives the round's coordinates (it needs them to find nearby pictures to walk
  to), so a determined player could cheat with the dev tools. It's a game for friends.
- Very strict NATs or firewalls can block WebRTC; PeerJS falls back to its public TURN relay
  where it can.
- Panoramax's 360° car coverage is densest in Europe and North America, and almost absent in
  Africa, so "World" rounds lean that way.

## Credits

Imagery © [Panoramax](https://panoramax.fr) contributors (CC-BY-SA / Etalab licences; the
photographer and licence are shown after each round). Place names in the recap come from
OpenStreetMap's [Nominatim](https://nominatim.org). Map data ©
[OpenStreetMap](https://www.openstreetmap.org/copyright) contributors; map style by
[HOT](https://www.hotosm.org/), hosted by [OSM France](https://openstreetmap.fr/).
