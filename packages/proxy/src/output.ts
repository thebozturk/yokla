// Reads the text a model answered (ADR-0033), for OpenAI-compatible chat
// completions, the Responses API, Anthropic Messages and Gemini, from a JSON
// answer or an event stream, with a streamed answer's pieces joined. Tool
// calls stay apart (ADR-0025). A body the proxy can't read gives null, never
// an empty text, so the origin of a finding stays unknown rather than wrong.
// A call that got no answer, or an error, said nothing.

import { gatewayAnswers, gatewayText } from './gateway.ts';
import { geminiAnswers, geminiText } from './gemini.ts';
import { sseEvents, type UpstreamKind } from './usage.ts';

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

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** A content that is a string, or a list of parts with text. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  return list(content)
    .flatMap((part) => {
      const text = str(at(part, 'text'));
      return text === undefined ? [] : [text];
    })
    .join('');
}

/** The Responses API: the text of its message output items. */
function responseText(output: unknown): string {
  return list(output)
    .filter((item) => at(item, 'type') === 'message')
    .map((item) => contentText(at(item, 'content')))
    .join('');
}

/** Anthropic: its text blocks. */
function anthropicText(content: unknown): string {
  return list(content)
    .filter((block) => at(block, 'type') === 'text')
    .map((block) => str(at(block, 'text')) ?? '')
    .join('');
}

function fromJson(kind: UpstreamKind, body: unknown): string | null {
  if (!isObject(body)) return null;
  if (kind === 'anthropic') return 'content' in body ? anthropicText(body['content']) : null;
  if ('choices' in body) return contentText(at(body, 'choices', 0, 'message', 'content'));
  if ('output' in body) return responseText(body['output']);
  // Embeddings answer with no text.
  if (at(body, 'object') === 'list') return '';
  return null;
}

function openAiStream(events: readonly unknown[]): string {
  const pieces: string[] = [];
  let completed: string | undefined;
  for (const event of events) {
    const type = str(at(event, 'type'));
    if (type === 'response.completed') {
      completed = responseText(at(event, 'response', 'output'));
    } else if (type === 'response.output_text.delta') {
      pieces.push(str(at(event, 'delta')) ?? '');
    } else {
      pieces.push(contentText(at(event, 'choices', 0, 'delta', 'content')));
    }
  }
  return completed ?? pieces.join('');
}

function anthropicStream(events: readonly unknown[]): string {
  return events
    .filter(
      (event) =>
        at(event, 'type') === 'content_block_delta' && at(event, 'delta', 'type') === 'text_delta',
    )
    .map((event) => str(at(event, 'delta', 'text')) ?? '')
    .join('');
}

/**
 * The text an answer gives; null when the answer can't be read. A call that
 * got no answer, or an error, gave ''.
 */
export function readOutputText(
  kind: UpstreamKind,
  body: string | undefined,
  stream: boolean,
  status: number | null,
): string | null {
  if (status === null || status < 200 || status > 299) return '';
  if (body === undefined) return null;
  if (kind === 'gemini') {
    const answers = geminiAnswers(body, stream, sseEvents);
    return answers === undefined ? null : geminiText(answers);
  }
  if (kind === 'ai-gateway') {
    const answers = gatewayAnswers(body, stream, sseEvents);
    return answers === undefined ? null : gatewayText(answers);
  }
  if (stream) {
    const events = sseEvents(body);
    if (events.length === 0) return null;
    return kind === 'anthropic' ? anthropicStream(events) : openAiStream(events);
  }
  try {
    return fromJson(kind, JSON.parse(body));
  } catch {
    return null;
  }
}
