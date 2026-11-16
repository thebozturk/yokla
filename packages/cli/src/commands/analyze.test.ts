import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer } from '@yokla/runtime/testing';
import { describe, expect, it } from 'vitest';
import { analyzeCommand } from './analyze.ts';
import { runCommand } from './run.ts';

function io() {
  const lines: string[] = [];
  return {
    lines,
    out: (line: string) => lines.push(line),
    err: (line: string) => lines.push(line),
  };
}

describe('yokla analyze options (ADR-0047)', () => {
  it.each([
    [[], '--url is required: the target to probe'],
    [['--url', 'not a url'], '--url "not a url" is not an absolute URL'],
    [['--url', 'ws://127.0.0.1:1/chat'], 'analyze probes HTTP targets only'],
    [
      ['--url', 'http://127.0.0.1:1/chat', '--max-files', '0'],
      '--max-files must be a positive integer',
    ],
    [
      ['--url', 'http://127.0.0.1:1/chat', '--body', '{"text": "hi"}'],
      'the request never sends {{message}}',
    ],
    [['--url', 'http://127.0.0.1:1/chat', '--language', 'de'], '--language is tr or en'],
    [['--url', 'http://127.0.0.1:1/chat', '--dir', '/no/such/folder'], "doesn't exist"],
  ])('refuses %j before it sends anything', async (args, message) => {
    const output = io();
    expect(await analyzeCommand(args, output, '0.0.0', tmpdir(), {})).toBe(2);
    expect(output.lines.join('\n')).toContain(message);
  });

  it('never overwrites a proposal without --force', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yokla-analyze-'));
    writeFileSync(join(dir, 'yokla.profile.proposed.yaml'), 'version: 1\n');
    const output = io();
    expect(
      await analyzeCommand(
        ['--url', 'http://127.0.0.1:1/chat', '--dir', dir],
        output,
        '0.0.0',
        dir,
        {},
      ),
    ).toBe(2);
    expect(output.lines).toContain(
      'yokla.profile.proposed.yaml already exists; --force overwrites',
    );
  });
});

const profile = (statuses: readonly string[]) => {
  const dir = mkdtempSync(join(tmpdir(), 'yokla-unapproved-'));
  mkdirSync(join(dir, 'cases'));
  writeFileSync(
    join(dir, 'cases', 'a.yaml'),
    'version: 1\ncases:\n  - { id: a, suite: quality, language: en, turns: [{ user: hi }] }\n',
  );
  const lines = statuses
    .map(
      (status, index) =>
        `  /target/response/${index === 0 ? 'text' : 'route'}: { source: probe, evidence: probe 1, status: ${status} }`,
    )
    .join('\n');
  writeFileSync(
    join(dir, 'yokla.profile.yaml'),
    `version: 1\nprovenance:\n${lines}\ntarget:\n  name: t\n  adapter: http\n  request: { url: 'http://127.0.0.1:1/chat', body: { message: '{{message}}' } }\n  response: { text: $.a, route: $.r }\nlanguages: [en]\ndomain: ecommerce\n`,
  );
  return join(dir, 'yokla.profile.yaml');
};

describe("a request that can't be sent (ADR-0047)", () => {
  it('stops the analysis, and nothing is written', async () => {
    const server = await startTestServer({
      onHttp: (_request, response) => {
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ answer: 'Hello! I can help you find products.' }));
      },
    });
    try {
      const dir = mkdtempSync(join(tmpdir(), 'yokla-analyze-'));
      const output = io();
      // {{auth.token}} with no target.auth: no token to send.
      const code = await analyzeCommand(
        [
          '--url',
          `${server.url.replace(/^ws/u, 'http')}/chat`,
          '--dir',
          dir,
          '--header',
          'authorization: Bearer {{auth.token}}',
        ],
        output,
        '0.0.0',
        dir,
        {},
      );
      expect(code, output.lines.join('\n')).toBe(2);
      expect(output.lines.join('\n')).toContain(
        "the request can't be sent: {{auth.token}} has no token",
      );
      expect(existsSync(join(dir, 'yokla.profile.proposed.yaml'))).toBe(false);
    } finally {
      await server.close();
    }
  });
});

describe('a profile with entries not approved (ADR-0047)', () => {
  it("doesn't run, and names each entry", async () => {
    const output = io();
    expect(
      await runCommand(['--profile', profile(['proposed', 'rejected'])], output, '0.0.0'),
    ).toBe(2);
    expect(output.lines.join('\n')).toContain(
      '2 entries are not approved:\n  /target/response/text (proposed)\n  /target/response/route (rejected)',
    );
  });

  it('gets past the check once every entry is approved', async () => {
    const output = io();
    // It goes on to the target, which isn't there: the run errors, not the profile.
    const path = profile(['approved', 'approved']);
    await runCommand(['--profile', path, '--out', `${path}.results.json`], output, '0.0.0');
    expect(output.lines.join('\n')).not.toContain('not approved');
  });
});
