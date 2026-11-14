// How yokla writes the path of an object's member, in the JSONPath style the
// profile uses: `.name`, or `["na me"]` for a name that isn't an identifier.

export function childPath(path: string, name: string): string {
  return /^[A-Za-z_][\w-]*$/u.test(name) ? `${path}.${name}` : `${path}[${JSON.stringify(name)}]`;
}
