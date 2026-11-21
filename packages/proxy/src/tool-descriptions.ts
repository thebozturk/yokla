// Changes to the descriptions of the tools a call offers, before the model
// sees them (ADR-0085): text appended to the named tool's description, or to
// every tool's when the change names none, on a new line, or as the
// description when it has none. A tool is found where ADR-0025 reads it, in
// every protocol the proxy speaks. A provider's built-in tool has no
// description to change: a change that names one is recorded as not applied,
// and a change for every tool leaves it out.

import type { DescriptionInjection, ToolResultChange } from '@yokla/core';
import type { UpstreamKind } from './usage.ts';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** An offered tool: the object that holds its description, or none for a built-in tool. */
interface Offered {
  readonly tool: string;
  readonly owner: Record<string, unknown> | undefined;
}

function offered(tool: string | undefined, owner?: Record<string, unknown>): Offered[] {
  return tool === undefined ? [] : [{ tool, owner }];
}

/** Every tool a request body offers, with where its description is. */
function offeredTools(kind: UpstreamKind, body: Record<string, unknown>): Offered[] {
  const tools = list(body['tools']).filter(isObject);
  if (kind === 'gemini') {
    // Function declarations have descriptions; a built-in tool is a key, such as googleSearch.
    return tools.flatMap((tool) =>
      'functionDeclarations' in tool
        ? list(tool['functionDeclarations'])
            .filter(isObject)
            .flatMap((declaration) => offered(str(declaration['name']), declaration))
        : Object.keys(tool).map((key) => ({ tool: key, owner: undefined })),
    );
  }
  if (kind === 'ai-gateway') {
    return tools.flatMap((tool) =>
      tool['type'] === 'function'
        ? offered(str(tool['name']), tool)
        : offered(str(tool['name']) ?? str(tool['id'])),
    );
  }
  if (kind === 'anthropic') {
    // A tool the app defines has an input schema; a server tool has none.
    return tools.flatMap((tool) =>
      'input_schema' in tool ? offered(str(tool['name']), tool) : offered(str(tool['name'])),
    );
  }
  // Chat completions: tools[].function, and the legacy functions; the Responses API: tools[].
  return [
    ...tools.flatMap((tool) => {
      const fn = tool['function'];
      if (isObject(fn)) return offered(str(fn['name']), fn);
      if (tool['type'] === 'function') return offered(str(tool['name']), tool);
      return offered(str(tool['name']) ?? str(tool['type']));
    }),
    ...list(body['functions'])
      .filter(isObject)
      .flatMap((fn) => offered(str(fn['name']), fn)),
  ];
}

/**
 * Applies the description changes to a parsed request body, in place, and
 * says what each did to each tool it is for: applied, or not. A change whose
 * tool the call doesn't offer leaves no entry.
 */
export function changeToolDescriptions(
  kind: UpstreamKind,
  body: unknown,
  changes: readonly DescriptionInjection[],
): ToolResultChange[] {
  if (!isObject(body) || changes.length === 0) return [];
  const tools = offeredTools(kind, body);
  return changes.flatMap((change) =>
    tools
      .filter(({ tool, owner }) =>
        change.tool === undefined ? owner !== undefined : tool === change.tool,
      )
      .map(({ tool, owner }) => {
        if (owner === undefined) return { kind: 'describe' as const, tool, applied: false };
        const description = str(owner['description']);
        owner['description'] =
          description === undefined || description === ''
            ? change.inject
            : `${description}\n${change.inject}`;
        return { kind: 'describe' as const, tool, applied: true };
      }),
  );
}
