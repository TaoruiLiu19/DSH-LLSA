import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { attributionHeaders, LlmAdapter, LlmError, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm';

export const LOCAL_CHILD_PROVIDER = 'llsa-local-child';
const LOOPBACK_BASE = /^https?:\/\/(?:127\.0\.0\.1|\[::1\])(?::[1-9]\d{0,4})?\/v1\/?$/u;
const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const OFF = ReasoningEffortId('off');

export function localChildConfig(config) {
  if (!config || typeof config.baseURL !== 'string' || !LOOPBACK_BASE.test(config.baseURL) ||
      typeof config.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(config.model) ||
      (config.apiKey !== undefined && (typeof config.apiKey !== 'string' || !/^[!-~]{1,512}$/u.test(config.apiKey)))) {
    throw new LlmError('Configure an OpenAI-compatible loopback /v1 endpoint and exact local model ID.', 'INVALID_LOCAL_CHILD_MODEL');
  }
  const base = new URL(config.baseURL);
  return Object.freeze({ model: config.model, endpoint: new URL('/v1/chat/completions', base).href, apiKey: config.apiKey });
}

function messageFor(message) {
  const content = [];
  const calls = [];
  for (const block of message.content) {
    if (block.type === 'text') content.push(block.text);
    else if (block.type === 'tool-call' && message.role === 'assistant') {
      calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } });
    } else if (!['reasoning', 'tool-addition', 'tool-removal'].includes(block.type)) {
      throw new LlmError('The local child model accepts text and managed tools.', 'UNSUPPORTED_LOCAL_CHILD_INPUT');
    }
  }
  const text = content.join('\n');
  if (message.role === 'tool') return { role: 'tool', content: text, tool_call_id: message.source.callId };
  if (calls.length) return { role: 'assistant', content: text || null, tool_calls: calls };
  if (!text) return null;
  return { role: message.role === 'developer' ? 'user' : message.role, content: text };
}

function requestLocal(config, payload, signal) {
  const data = Buffer.from(JSON.stringify(payload));
  if (data.length > MAX_REQUEST_BYTES) throw new LlmError('The local child input exceeds its byte limit.', 'LOCAL_CHILD_INPUT_TOO_LARGE');
  const request = config.endpoint.startsWith('https:') ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(config.endpoint, {
      agent: false,
      method: 'POST',
      headers: {
        ...attributionHeaders(),
        'content-type': 'application/json',
        'content-length': data.length,
        ...(config.apiKey ? { authorization: 'Bearer ' + config.apiKey } : {}),
      },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, res => {
      if (res.statusCode !== 200) {
        res.destroy();
        reject(new LlmError('The local child endpoint returned HTTP ' + res.statusCode, 'LOCAL_CHILD_HTTP'));
        return;
      }
      const buffers = [];
      let size = 0;
      res.on('error', reject);
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          reject(new LlmError('The local child response exceeds its byte limit.', 'LOCAL_CHILD_RESPONSE_TOO_LARGE'));
          res.destroy();
          return;
        }
        buffers.push(chunk);
      });
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(buffers).toString('utf8'))); }
        catch { reject(new LlmError('The local child endpoint returned invalid JSON.', 'MALFORMED_RESPONSE')); }
      });
    });
    req.on('error', error => reject(signal?.aborted ? signal.reason : error));
    req.end(data);
  });
}

function returnedBlocks(choice, tools) {
  if (!choice?.message || !['stop', 'tool_calls', 'length'].includes(choice.finish_reason)) {
    throw new LlmError('The local child endpoint returned an invalid completion.', 'MALFORMED_RESPONSE');
  }
  const blocks = [];
  if (typeof choice.message.content === 'string' && choice.message.content) {
    blocks.push({ type: 'text', text: choice.message.content });
  }
  if (choice.finish_reason === 'length') return blocks;
  const ids = new Set();
  for (const call of choice.message.tool_calls ?? []) {
    if (call?.type !== 'function' || typeof call.id !== 'string' || !call.id || ids.has(call.id) ||
        !tools.some(tool => tool.name === call.function?.name) || typeof call.function?.arguments !== 'string') {
      throw new LlmError('The local child returned an invalid managed tool call.', 'MALFORMED_RESPONSE');
    }
    try { JSON.parse(call.function.arguments); }
    catch { throw new LlmError('The local child returned invalid tool arguments.', 'MALFORMED_RESPONSE'); }
    ids.add(call.id);
    blocks.push({ type: 'tool-call', id: ToolCallId(call.id), name: call.function.name, arguments: call.function.arguments });
  }
  if (choice.finish_reason === 'tool_calls' && !ids.size) {
    throw new LlmError('The local child completion omitted its managed tool call.', 'MALFORMED_RESPONSE');
  }
  return blocks;
}

export class LocalChildModel extends LlmAdapter {
  #config;
  constructor(config) {
    super();
    this.#config = localChildConfig(config);
  }
  providerInfo(provider) { return { id: provider, name: 'LLSA local child' }; }
  async listModels(provider) { return [await this.resolveModel(provider, this.#config.model)]; }

  async resolveModel(provider, model) {
    if (provider !== LOCAL_CHILD_PROVIDER || model !== this.#config.model) {
      throw new LlmError('Unknown local child model route.', 'INVALID_LOCAL_CHILD_MODEL');
    }
    return { provider, id: model, name: model, defaultMaxTokens: 1024,
      reasoning: { efforts: [{ id: OFF, name: 'Off' }], defaultEffort: OFF } };
  }

  async *stream(options) {
    await this.resolveModel(options.provider, options.model);
    const messages = options.messages.map(messageFor).filter(Boolean);
    if (options.system) messages.unshift({ role: 'system', content: options.system });
    const tools = options.tools ?? [];
    const response = await requestLocal(this.#config, {
      model: this.#config.model, stream: false, messages,
      ...(tools.length ? { tools: tools.map(({ name, description, parameters }) =>
        ({ type: 'function', function: { name, description, parameters } })) } : {}),
      temperature: options.temperature ?? 0,
      max_tokens: Math.min(4096, options.maxTokens ?? 1024),
      ...(options.stop?.length ? { stop: options.stop } : {}),
      chat_template_kwargs: { enable_thinking: false },
    }, options.signal);
    const choice = response?.choices?.[0];
    const blocks = returnedBlocks(choice, tools);
    for (const [index, block] of blocks.entries()) {
      yield { type: 'block-start', index, blockType: block.type };
      yield block.type === 'text' ? { type: 'text-delta', index, text: block.text } :
        { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments };
      yield { type: 'block-end', index, block };
    }
    const { prompt_tokens: input, completion_tokens: output, prompt_tokens_details: details } = response.usage ?? {};
    const cached = details?.cached_tokens;
    if ([input, output].every(value => Number.isSafeInteger(value) && value >= 0)) {
      const reads = Number.isSafeInteger(cached) && cached >= 0 && cached <= input ? cached : 0;
      yield { type: 'usage', usage: { inputTokens: input - reads, outputTokens: output, totalTokens: input + output,
        cacheReadTokens: reads, cacheWriteTokens: 0 } };
    }
    yield { type: 'finish', reason: { kind: choice.finish_reason === 'length' ? 'max-tokens' :
      blocks.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop' } };
  }
}
