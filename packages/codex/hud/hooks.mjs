import { recordHook } from './collector.mjs';

const MAX_BYTES = 4 * 1024 * 1024;

try {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes <= MAX_BYTES) chunks.push(chunk);
  }
  if (bytes > 0 && bytes <= MAX_BYTES) recordHook(JSON.parse(Buffer.concat(chunks).toString('utf8')));
} catch {
  // Telemetry must never block, change, or add messages to the Codex operation being observed.
}
