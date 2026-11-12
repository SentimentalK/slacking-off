// Zero-dependency fixture server for visual checks: `node web/dev/mock-api.mjs`.
// Point Vite at it with `LOO_API_URL=http://127.0.0.1:5174 npm run dev`.
//
// Fixtures mirror `.conductor/contract-E.md` §2–§3. `projection.json` is the
// three-tick live loop behind SSE; `replay.json` holds one frame per tick so
// the replay page can be scrubbed.

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, name), 'utf8'));

const terrain = fixture('terrain.json');
const live = fixture('projection.json');
const replay = fixture('replay.json');
const worlds = fixture('worlds.json');
const timeline = fixture('timeline.json');
const leaderboards = fixture('leaderboard.json');
const stats = fixture('stats.json');
const agents = fixture('agents.json');
const port = Number(process.env.PORT ?? 5174);

const exactFrames = new Map(replay.frames.map((frame) => [frame.tick, frame]));
const ascendingFrames = [...replay.frames].sort((a, b) => a.tick - b.tick);

const envelope = (result) => JSON.stringify({ ok: true, result });
const failure = (status, code, message) => ({
  status,
  body: JSON.stringify({ ok: false, error: { code, message } }),
});
const json = (res, body) => {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
};

/** Nearest recorded frame at or before `tick`, clamped to the recorded range. */
function frameAt(tick) {
  if (!Number.isFinite(tick)) return ascendingFrames[ascendingFrames.length - 1];
  const exact = exactFrames.get(tick);
  if (exact) return exact;
  let best = ascendingFrames[0];
  for (const frame of ascendingFrames) {
    if (frame.tick <= tick) best = frame;
    else break;
  }
  return best;
}

let cursor = 0;
const subscribers = new Set();

setInterval(() => {
  cursor = (cursor + 1) % live.length;
  for (const send of subscribers) send(cursor);
}, 1000);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const path = url.pathname;

  if (path === '/api/terrain') {
    json(res, JSON.stringify(terrain));
    return;
  }

  if (path === '/api/worlds') {
    json(res, envelope(worlds));
    return;
  }

  if (path === '/api/projection') {
    if (url.searchParams.has('tick')) {
      json(res, envelope(frameAt(Number(url.searchParams.get('tick')))));
    } else {
      json(res, envelope(live[cursor]));
    }
    return;
  }

  if (path === '/api/timeline') {
    const from = Number(url.searchParams.get('from') ?? 0);
    const to = Number(url.searchParams.get('to') ?? Number.MAX_SAFE_INTEGER);
    const markers = timeline.markers
      .filter((marker) => marker.tick >= from && marker.tick <= to)
      .sort((a, b) => a.tick - b.tick)
      .slice(0, 5000);
    json(res, envelope({ from: Number.isFinite(from) ? from : 0, to, markers }));
    return;
  }

  if (path === '/api/leaderboard') {
    const metric = url.searchParams.get('metric') ?? 'score';
    const board = leaderboards[metric] ?? leaderboards.score;
    const model = url.searchParams.get('model');
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
    const rows = board
      .filter((row) => !model || row.model === model)
      .slice(0, limit)
      .map((row, index) => ({ ...row, rank: index + 1 }));
    json(res, envelope(rows));
    return;
  }

  if (path === '/api/stats') {
    json(res, envelope(stats));
    return;
  }

  const agent = /^\/api\/agents\/(\d+)$/.exec(path);
  if (agent) {
    const profile = agents[agent[1]];
    if (!profile) {
      const missing = failure(404, 'not_found', '没有这个 Agent');
      res.writeHead(missing.status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(missing.body);
      return;
    }
    json(res, envelope(profile));
    return;
  }

  if (path === '/api/watch') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (index) => {
      const projection = live[index];
      res.write(`id: ${projection.tick}\nevent: tick\ndata: ${JSON.stringify(projection)}\n\n`);
    };
    res.write('retry: 3000\n\n');
    res.write(
      `event: hello\ndata: ${JSON.stringify({
        world: live[cursor].world,
        tick: live[cursor].tick,
        tick_seconds: live[cursor].tick_seconds,
      })}\n\n`,
    );
    send(cursor);
    subscribers.add(send);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      subscribers.delete(send);
    });
    return;
  }

  const missing = failure(404, 'not_found', `${path} 不存在`);
  res.writeHead(missing.status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(missing.body);
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`mock api on http://127.0.0.1:${port}\n`);
});
