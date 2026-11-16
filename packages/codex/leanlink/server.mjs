import { homedir } from 'node:os';
import { join } from 'node:path';
import manifest from '../.codex-plugin/plugin.json' with { type: 'json' };
import { Archive, ToolError } from './store.mjs';
import { findTool, invoke, tools } from './tools.mjs';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const result = (id, value) => ({ jsonrpc: '2.0', id, result: value });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const content = (value, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}) });

/** Stdio transport carries one UTF-8 JSON-RPC message per newline. */
async function* frames(input) {
  let length = 0;
  let pieces = [];
  for await (const chunk of input) {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      length += end - offset;
      if (length <= MAX_FRAME_BYTES) pieces.push(chunk.subarray(offset, end));
      else pieces = [];
      if (newline === -1) break;
      yield length > MAX_FRAME_BYTES ? null : Buffer.concat(pieces, length);
      length = 0;
      pieces = [];
      offset = newline + 1;
    }
  }
}

function protocolHandler(archive) {
  let phase = 'initial';
  return message => {
    const id = message?.id;
    const isRequest = Object.hasOwn(message ?? {}, 'id');
    const validId = Number.isSafeInteger(id) || typeof id === 'string';
    if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || (isRequest && !validId)) {
      return rpcError(validId ? id : null, -32600, 'Invalid request');
    }
    const { method, params } = message;
    if (!isRequest) {
      if (method === 'notifications/initialized' && phase === 'initializing') phase = 'ready';
      return undefined;
    }
    if (params !== undefined && !isObject(params)) return rpcError(id, -32602, 'Params must be an object');
    if (method === 'ping') return result(id, {});
    if (method === 'initialize') {
      if (phase !== 'initial') return rpcError(id, -32600, 'Already initialized');
      if (typeof params?.protocolVersion !== 'string' || !isObject(params.capabilities) || !isObject(params.clientInfo) ||
          typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') {
        return rpcError(id, -32602, 'Invalid initialize parameters');
      }
      phase = 'initializing';
      const protocolVersion = PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0];
      return result(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'leanlink', version: manifest.version } });
    }
    if (phase !== 'ready') return rpcError(id, -32000, 'Complete initialization first');
    if (method === 'tools/list') {
      if (params?.cursor !== undefined) return rpcError(id, -32602, 'Invalid tools cursor');
      return result(id, { tools });
    }
    if (method !== 'tools/call') return rpcError(id, -32601, 'Method not found');
    if (typeof params?.name !== 'string' || (params.arguments !== undefined && !isObject(params.arguments))) {
      return rpcError(id, -32602, 'Invalid tool call parameters');
    }
    const tool = findTool(params.name);
    if (!tool) return rpcError(id, -32602, 'Unknown tool');
    try {
      return result(id, content(invoke(archive, tool, params.arguments ?? {})));
    } catch (error) {
      if (error instanceof ToolError) return result(id, content({ code: error.code, message: error.message, ...error.details }, true));
      if (error.errcode === 5) return result(id, content({ code: 'ARCHIVE_BUSY', message: 'Retry with the same opId' }, true));
      return rpcError(id, -32603, 'Archive operation failed');
    }
  };
}

const archive = new Archive(process.env.CODEX_LEANLINK_HOME || join(homedir(), '.leanlink-codex'), process.env.CODEX_LEANLINK_WORKSPACE);
try {
  const handle = protocolHandler(archive);
  for await (const frame of frames(process.stdin)) {
    if (frame?.length === 0) continue;
    let reply;
    let message;
    try {
      if (frame === null) throw new Error('Frame too large');
      message = JSON.parse(decoder.decode(frame));
    } catch {
      reply = rpcError(null, -32700, 'Parse error');
    }
    reply ??= handle(message);
    if (reply === undefined) continue;
    await new Promise((resolve, reject) => {
      process.stdout.write(`${JSON.stringify(reply)}\n`, error => error ? reject(error) : resolve());
    });
  }
} finally {
  archive.close();
}
