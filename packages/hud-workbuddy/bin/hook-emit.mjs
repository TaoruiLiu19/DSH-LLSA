/**
 * Hook trampoline: stdin JSON -> local HUD service.
 *
 * Deliberately fire-and-forget. A HUD outage must never block a tool call, so
 * every failure path exits 0. Uses a short timeout and no retry.
 */
import { request } from 'node:http';

const PORT = Number.parseInt(process.env.HUD_PORT ?? '4317', 10);
const TIMEOUT_MS = 400;

const chunks = [];
let size = 0;
process.stdin.on('data', chunk => {
  size += chunk.length;
  if (size <= 1_000_000) chunks.push(chunk);
});
process.stdin.on('end', () => {
  if (size === 0 || size > 1_000_000) process.exit(0);
  try {
    JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    process.exit(0);
  }
  const req = request(
    { host: '127.0.0.1', port: PORT, path: '/event', method: 'POST', timeout: TIMEOUT_MS,
      headers: { 'content-type': 'application/json', 'content-length': size } },
    response => {
      response.resume();
      process.exit(0);
    },
  );
  req.on('timeout', () => req.destroy());
  req.on('error', () => process.exit(0));
  req.end(Buffer.concat(chunks));
});
