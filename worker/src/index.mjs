// Now-playing strip. Reads my Spotify status from Discord via Lanyard and
// answers with an SVG strip drawn by the same renderer as the static ones.

import data from './generated.mjs';
import { renderStrip, nowRows } from '../../lib/strip.mjs';

const LANYARD = `https://api.lanyard.rest/v1/users/${data.discordId}`;

async function currentTrack() {
  try {
    const res = await fetch(LANYARD, { headers: { accept: 'application/json' }, cf: { cacheTtl: 0 } });
    if (!res.ok) return null;
    const { data: presence } = await res.json();
    if (!presence?.listening_to_spotify || !presence.spotify?.song) return null;
    const { song, artist, timestamps } = presence.spotify;
    const track = { song, artist: (artist ?? '').replace(/;\s*/g, ', ') };
    const { start, end } = timestamps ?? {};
    if (start && end && end > start) {
      const now = Date.now();
      track.progress = Math.min(1, Math.max(0, (now - start) / (end - start)));
      track.remainingMs = Math.max(0, end - now);
    }
    return track;
  } catch {
    return null;
  }
}

export default {
  async fetch() {
    const track = await currentTrack();
    const idle = data.idle[Math.floor(Math.random() * data.idle.length)];
    const rows = nowRows(data.font, track, idle);
    const svg = renderStrip({
      id: 'now',
      theme: data.theme,
      font: data.font,
      rows,
      stars: data.stars,
      starOpacity: data.starOpacity,
      title: track ? `now playing: ${track.song} — ${track.artist}` : `now playing: ${idle}`,
    });
    return new Response(svg, {
      headers: {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': 'no-cache, max-age=0, must-revalidate',
        'access-control-allow-origin': '*',
      },
    });
  },
};
