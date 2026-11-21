import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import register from '../index.ts';

test('Ctrl+G selects the local backend and round-trips Rex edits', { timeout: 10000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rex test '));
  const env = { ...process.env };
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    await rm(dir, { recursive: true, force: true });
  });
  Object.assign(process.env, {
    PATH: `${dir}:${env.PATH}`, PI_CODING_AGENT_DIR: dir,
    SPLIT_EDITOR_SIZE: '37%', SPLIT_EDITOR_DIRECTION: 'vertical', SPLIT_EDITOR_EDITOR: 'test-editor --flag',
    REX_SESSION: 'source-session', LOG: join(dir, 'args'),
  });
  delete process.env.TMUX;
  delete process.env.REX_BLOCK;
  for (const [name, script] of Object.entries({
    rex: `printf '%s\\n' "$@" > "$LOG"; while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done; shift || exit 1; exec "$@"`,
    'test-editor': `[ "$1" = --flag ] || exit 1; printf ' edited\\n' >> "$2"; exit 7`,
    tmux: 'echo fake-tmux >&2; exit 1',
  })) await writeFile(join(dir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });

  const events = {};
  register({ on: (name, fn) => { events[name] = fn; } });
  let input, finished;
  let prompt = 'original';
  const notices = [];
  const ui = {
    onTerminalInput: (fn) => { input = fn; return () => {}; },
    notify: (msg) => notices.push(msg),
    setWidget: (_, content) => { if (!content) finished?.(); },
    getEditorText: () => prompt,
    setEditorText: (text) => { prompt = text; },
  };
  events.session_start({}, { hasUI: true, ui, cwd: dir });
  const trigger = () => input('\x07');
  const edit = async () => {
    const done = new Promise((resolve) => { finished = resolve; });
    assert.deepEqual(trigger(), { consume: true });
    assert.deepEqual(input('x'), { consume: true }); // locked during open
    await done;
    assert.equal(input('x'), undefined);
  };

  assert.equal(trigger(), undefined); // partial Rex environment must not target a focused pane
  process.env.REX_BLOCK = 'source-block';
  await edit();
  const args = (await readFile(process.env.LOG, 'utf8')).split('\n');
  assert.deepEqual(args.slice(0, -2), ['split', '-s', 'source-session', '-b', 'source-block', '-c', dir,
    '--split=below', '--ratio', '37', '--wait', '--', 'sh', '-c']);
  assert.equal(prompt, 'original edited');
  assert.match(notices.at(-1), /editor exited with status 7/);

  process.env.TMUX = 'nested';
  await edit();
  assert.match(notices.at(-1), /tmux split-window failed.*fake-tmux/);
  assert.equal(prompt, 'original edited');
});
