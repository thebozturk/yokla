// How a cold sample avoids the target's response cache (design §11, P5):
// a request header, or a local command run before the sample.

import type { ProfileTarget } from '@yokla/core';
import { runCommandOrFail } from './command.ts';

export interface CacheBypass {
  /** Headers to add to every request of a cold sample. */
  readonly headers: Readonly<Record<string, string>>;
  /** Runs before each cold sample. */
  prepare(): Promise<void>;
  /** For the report, e.g. "header x-cache-bypass" or "command ./flush.sh". */
  readonly description: string;
}

export function cacheBypass(
  config: ProfileTarget['cacheBypass'],
  cwd: string | undefined,
): CacheBypass {
  switch (config.kind) {
    case 'header':
      return {
        headers: { [config.name.toLowerCase()]: config.value },
        prepare: () => Promise.resolve(),
        description: `header ${config.name}`,
      };
    case 'command':
      return {
        headers: {},
        prepare: async () => {
          await runCommandOrFail(config.run, { timeoutMs: config.timeoutMs, cwd });
        },
        description: `command ${config.run.join(' ')}`,
      };
    case 'none':
      return { headers: {}, prepare: () => Promise.resolve(), description: 'none' };
  }
}
