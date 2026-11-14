// Gemini's native API (ADR-0032), on AI Studio and Vertex AI alike: the model
// is in the url (`…/models/{model}:{method}`), streaming is the
// streamGenerateContent method, answering with server-sent events (alt=sse)
// or else a JSON array of answers. Messages are `contents` of `parts`, tools
// are `functionDeclarations`, and usage is `usageMetadata`, with thinking
// tokens apart from the output. A count the answer doesn't give is null.

import type { PromptMessage, ProxyUsage } from '@yokla/core';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function at(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof key === 'number') current = Array.isArray(current) ? current[key] : undefined;
    else current = isObject(current) ? current[key] : undefined;
  }
  return current;
}

function tokens(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The model and method a path names, such as models/gemini-2.5-flash:generateContent. */
export function geminiFacts(path: string): { model: string | null; stream: boolean } {
  const match = /\/models\/([^/:?]+):(\w+)/u.exec(path);
  return { model: match?.[1] ?? null, stream: match?.[2] === 'streamGenerateContent' };
}

/**
 * The answers in a body: one JSON answer, or a stream's, as server-sent events
 * or a JSON array. Undefined when the body can't be read.
 */
export function geminiAnswers(
  body: string,
  stream: boolean,
  sse: (text: string) => unknown[],
): unknown[] | undefined {
  const trimmed = body.trim();
  if (stream && !trimmed.startsWith('[')) {
    const events = sse(body);
    return events.length === 0 ? undefined : events;
  }
  try {
    const value: unknown = JSON.parse(trimmed);
    const answers: unknown[] = Array.isArray(value) ? value : [value];
    return answers;
  } catch {
    return undefined;
  }
}

/** usageMetadata as yokla counts it: input and output hold every token billed as such. */
function usageOf(metadata: unknown): ProxyUsage | undefined {
  if (!isObject(metadata)) return undefined;
  const prompt = tokens(metadata['promptTokenCount']);
  const toolUse = tokens(metadata['toolUsePromptTokenCount']);
  const candidates = tokens(metadata['candidatesTokenCount']);
  const thoughts = tokens(metadata['thoughtsTokenCount']);
  return {
    input: prompt === null ? null : prompt + (toolUse ?? 0),
    // An answer that is only thinking reports no candidates: its output is its thoughts.
    output: candidates === null && thoughts === null ? null : (candidates ?? 0) + (thoughts ?? 0),
    cachedInput: tokens(metadata['cachedContentTokenCount']),
    cacheWrite: null,
    reasoning: thoughts,
  };
}

/** The usage and model of the answers; in a stream, the last usage reported. */
export function geminiUsage(answers: readonly unknown[]): {
  usage: ProxyUsage | undefined;
  model: string | null;
} {
  let usage: ProxyUsage | undefined;
  let model: string | null = null;
  for (const answer of answers) {
    usage = usageOf(at(answer, 'usageMetadata')) ?? usage;
    const version = str(at(answer, 'modelVersion'));
    if (version !== undefined && version !== '') model = version;
  }
  return { usage, model };
}

/** The parts of the answers' first candidate, in order. */
function answerParts(answers: readonly unknown[]): unknown[] {
  return answers.flatMap((answer) => list(at(answer, 'candidates', 0, 'content', 'parts')));
}

/** The tool calls the answers ask for: their functionCall parts, args as JSON text. */
export function geminiToolCalls(
  answers: readonly unknown[],
): { name: string; arguments: string }[] {
  return answerParts(answers).flatMap((part) => {
    const name = str(at(part, 'functionCall', 'name'));
    if (name === undefined) return [];
    const args = at(part, 'functionCall', 'args');
    return [{ name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) }];
  });
}

/** The text the answers give: their text parts, thought summaries left out (ADR-0033). */
export function geminiText(answers: readonly unknown[]): string {
  return answerParts(answers)
    .flatMap((part) => {
      const text = str(at(part, 'text'));
      return text === undefined || at(part, 'thought') === true ? [] : [text];
    })
    .join('');
}

/** The names of the tools a request offers: function declarations, and built-in tools by key. */
export function geminiOffered(tools: unknown): string[] {
  return list(tools).flatMap((tool) => {
    if (!isObject(tool)) return [];
    const declared = list(tool['functionDeclarations']).flatMap((declaration) => {
      const name = str(at(declaration, 'name'));
      return name === undefined ? [] : [name];
    });
    return 'functionDeclarations' in tool ? declared : Object.keys(tool);
  });
}

function message(role: PromptMessage['role'], text: string, tool?: string): PromptMessage {
  return { role, chars: text.length, text, ...(tool === undefined ? {} : { tool }) };
}

function partsText(content: unknown): string {
  if (typeof content === 'string') return content;
  return list(at(content, 'parts'))
    .flatMap((part) => {
      const text = str(at(part, 'text'));
      return text === undefined ? [] : [text];
    })
    .join('\n');
}

/**
 * The messages a request sends: systemInstruction, then each of contents. A
 * model's functionCall is its message's text; a functionResponse is a tool
 * message that names its tool (ADR-0026). Embeddings send their content as
 * input. Null for a shape it doesn't know.
 */
export function geminiPrompt(body: Record<string, unknown>): PromptMessage[] | null {
  const out: PromptMessage[] = [];
  if (body['systemInstruction'] !== undefined) {
    out.push(message('system', partsText(body['systemInstruction'])));
  }
  const contents = body['contents'];
  if (!Array.isArray(contents)) {
    const inputs = [
      ...(isObject(body['content']) ? [body['content']] : []),
      ...list(body['requests']).map((request) => at(request, 'content')),
    ];
    return inputs.length === 0
      ? null
      : inputs.map((content) => message('input', partsText(content)));
  }
  for (const content of contents) {
    if (!isObject(content)) throw new Error('a content that is not an object');
    const role = content['role'] === 'model' ? 'assistant' : 'user';
    const own: string[] = [];
    const results: PromptMessage[] = [];
    for (const part of list(content['parts'])) {
      if (!isObject(part)) throw new Error('a part that is not an object');
      if (typeof part['text'] === 'string') own.push(part['text']);
      else if (isObject(part['functionCall'])) {
        own.push(JSON.stringify(part['functionCall']['args'] ?? {}));
      } else if (isObject(part['functionResponse'])) {
        const response = part['functionResponse'];
        results.push(
          message('tool', JSON.stringify(response['response'] ?? null), str(response['name'])),
        );
      }
    }
    if (own.length > 0 || results.length === 0) out.push(message(role, own.join('\n')));
    out.push(...results);
  }
  return out;
}

/** Gemini's error body, as the API answers a failed call. */
export function geminiError(status: 429 | 500 | 503, said: string): string {
  const name = status === 429 ? 'RESOURCE_EXHAUSTED' : status === 503 ? 'UNAVAILABLE' : 'INTERNAL';
  return JSON.stringify({ error: { code: status, message: said, status: name } });
}

/** Empties the text parts of an answer's candidates; true when it changed one. */
export function geminiEmptyText(answer: unknown): boolean {
  let changed = false;
  for (const candidate of list(at(answer, 'candidates'))) {
    for (const part of list(at(candidate, 'content', 'parts'))) {
      if (isObject(part) && typeof part['text'] === 'string' && part['text'] !== '') {
        part['text'] = '';
        changed = true;
      }
    }
  }
  return changed;
}

/** Turns each functionCall's args into text that isn't a JSON object; true when there was one. */
export function geminiBreakToolCalls(answer: unknown, broken: string): boolean {
  let changed = false;
  for (const candidate of list(at(answer, 'candidates'))) {
    for (const part of list(at(candidate, 'content', 'parts'))) {
      const call = at(part, 'functionCall');
      if (isObject(call)) {
        call['args'] = broken;
        changed = true;
      }
    }
  }
  return changed;
}
