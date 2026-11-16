// What a run reached (ADR-0044), measured from its turns' routes and the model
// calls the proxy tied to them, before the results keep only what the profile
// says of their arguments: a shape needs the arguments' keys.

import { argumentShape, type Coverage } from '@yokla/core';
import type { TurnProxy } from './proxy.ts';

/** A turn as coverage reads it: the route it answered on, and its model calls. */
export interface CoveredTurn {
  readonly route: string | undefined;
  readonly proxy: TurnProxy | undefined;
}

const sorted = (values: ReadonlySet<string>): string[] => [...values].toSorted();

export function measureCoverage(turns: Iterable<CoveredTurn>): Coverage {
  const routes = new Set<string>();
  const tools = new Set<string>();
  const shapes = new Set<string>();
  const faultStates = new Set<string>();
  const offered = new Set<string>();
  for (const { route, proxy } of turns) {
    if (route !== undefined) routes.add(route);
    for (const call of proxy?.calls ?? []) {
      for (const tool of call.tools ?? []) offered.add(tool);
      for (const asked of call.toolCalls ?? []) {
        tools.add(asked.name);
        shapes.add(argumentShape(asked.name, asked.arguments));
      }
      if (call.fault?.applied === true && route !== undefined) {
        faultStates.add(`${route}/${call.fault.kind}`);
      }
    }
  }
  return {
    routes: sorted(routes),
    tools: sorted(tools),
    shapes: sorted(shapes),
    faultStates: sorted(faultStates),
    offered: sorted(offered),
  };
}
