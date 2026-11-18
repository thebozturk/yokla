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

  it.each([
    [['--max-tokens', '0'], '--max-tokens must be a positive integer'],
    [['--chunk-tokens', 'many'], '--chunk-tokens must be a positive integer'],
  ])('refuses %j before it sends anything', async (args, message) => {
    const output = io();
    const code = await analyzeCommand(
      ['--url', 'http://127.0.0.1:1/chat', ...args],
      output,
      '0.0.0',
      tmpdir(),
      {},
    );
    expect(code).toBe(2);
    expect(output.lines.join('\n')).toContain(message);
  });

  it('estimates with a model whose key is not set yet, and sends nothing (ADR-0049)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yokla-analyze-'));
    writeFileSync(join(dir, 'README.md'), 'Send `x-cache-bypass: 1` to skip the cache.\n');
    writeFileSync(
      join(dir, 'yokla.config.yaml'),
      [
        'version: 1',
        'models:',
        '  analyzer:',
        '    kind: anthropic',
        '    url: http://127.0.0.1:1/v1',
        '    model: m',
        '    apiKeyEnv: YOKLA_UNSET_ANALYZER_KEY',
        '    maxTokens: 1000',
        '    price: { input: 1, output: 2 }',
        '',
      ].join('\n'),
    );
    const output = io();
    const code = await analyzeCommand(
      ['--url', 'http://127.0.0.1:1/chat', '--dir', dir, '--estimate'],
      output,
      '0.0.0',
      dir,
      {},
    );
    const text = output.lines.join('\n');
    expect(code, text).toBe(0);
    expect(text).toContain('model step: 1 file(s) to m at http://127.0.0.1:1/v1');
    expect(text).toMatch(/estimated cost \$\d+\.\d{4}, at most \$\d+\.\d{4}/u);
    expect(text).toContain('--estimate: nothing was sent');
  });

  it('refuses a model with no price, since --max-cost could not be kept (ADR-0049)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yokla-analyze-'));
    writeFileSync(
      join(dir, 'yokla.config.yaml'),
      'version: 1\nmodels:\n  analyzer: { kind: openai-compatible, url: http://127.0.0.1:1/v1, model: m }\n',
    );
    const output = io();
    const code = await analyzeCommand(
      ['--url', 'http://127.0.0.1:1/chat', '--dir', dir, '--max-cost', '1'],
      output,
      '0.0.0',
      dir,
      {},
    );
    expect(code).toBe(2);
    expect(output.lines.join('\n')).toContain(
      'models.analyzer has no price, so --max-cost could not be enforced',
    );
  });

  it('refuses --data that is missing or not data, before it sends anything (ADR-0065)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yokla-analyze-'));
    writeFileSync(join(dir, 'notes.md'), '# notes\n');
    const refused = async (data: string) => {
      const output = io();
      const code = await analyzeCommand(
        ['--url', 'http://127.0.0.1:1/chat', '--dir', dir, '--data', data],
        output,
        '0.0.0',
        dir,
        {},
      );
      return [code, output.lines.join('\n')];
    };
    expect(await refused('missing.jsonl')).toEqual([2, "--data missing.jsonl doesn't exist"]);
    expect(await refused(dir)).toEqual([2, `--data ${dir} doesn't exist`]);
    const [code, message] = await refused('notes.md');
    expect(code).toBe(2);
    expect(message).toContain(
      '--data notes.md is not a data file: JSON Lines, CSV, or a JSON array of objects',
    );
  });

  it('estimates without a model too, and sends nothing (ADR-0049)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yokla-analyze-'));
    const output = io();
    // The target isn't there: anything sent would fail.
    const code = await analyzeCommand(
      ['--url', 'http://127.0.0.1:1/chat', '--dir', dir, '--estimate'],
      output,
      '0.0.0',
      dir,
      {},
    );
    expect(code, output.lines.join('\n')).toBe(0);
    expect(output.lines).toContain(
      'no models.analyzer in the configuration: the analysis would use no model',
    );
    expect(output.lines).toContain('--estimate: nothing was sent');
    expect(existsSync(join(dir, 'yokla.profile.proposed.yaml'))).toBe(false);
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
