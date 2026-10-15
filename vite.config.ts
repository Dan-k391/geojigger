import { defineConfig } from 'vite';

// Relative base so the built site works from any static host / subpath (e.g. GitHub Pages).
export default defineConfig({
  base: './',
  // three.js + Leaflet + PeerJS make one ~1 MB bundle; fine for a game.
  build: { chunkSizeWarningLimit: 1500 },
});
