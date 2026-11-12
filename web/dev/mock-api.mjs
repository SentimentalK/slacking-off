// Zero-dependency fixture server for visual checks: `node web/dev/mock-api.mjs`.
// Point Vite at it with `LOO_API_URL=http://127.0.0.1:5174 npm run dev`.

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const terrain = JSON.parse(readFileSync(join(here, 'terrain.json'), 'utf8'));
const projections = JSON.parse(readFileSync(join(here, 'projection.json'), 'utf8'));
const port = Number(process.env.PORT ?? 5174);

const envelope = (result) => JSON.stringify({ ok: true, result });
const failure = (status, code, message) => ({ status, body: JSON.stringify({ ok: false, error: { code, message } }) });

let cursor = 0;
/** Mock clients each get their own position in the three-tick loop. */
const subscribers = new Set();

setInterval(() => {
  cursor = (cursor + 1) % projections.length;
  for (const send of subscribers) send(cursor);
}, 1000);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);

  if (url.pathname === '/api/terrain') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(terrain));
    return;
  }

  if (url.pathname === '/api/projection') {
    const requested = Number(url.searchParams.get('tick'));
    const found = Number.isFinite(requested) && url.searchParams.has('tick')
      ? projections.find((entry) => entry.tick === requested) ?? projections[projections.length - 1]
      : projections[cursor];
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(envelope(found));
    return;
  }

  if (url.pathname === '/api/leaderboard') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(envelope([]));
    return;
  }

  if (url.pathname === '/api/watch') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (index) => {
      const projection = projections[index];
      res.write(`id: ${projection.tick}\nevent: tick\ndata: ${JSON.stringify(projection)}\n\n`);
    };
    res.write('retry: 3000\n\n');
    res.write(
      `event: hello\ndata: ${JSON.stringify({
        world: projections[cursor].world,
        tick: projections[cursor].tick,
        tick_seconds: projections[cursor].tick_seconds,
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

  const missing = failure(404, 'not_found', `${url.pathname} 不存在`);
  res.writeHead(missing.status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(missing.body);
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`mock api on http://127.0.0.1:${port}\n`);
});
