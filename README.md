# split-editor

Edit pi prompts in a live tmux or [Superlogical Rex](https://www.superlogical.com/rex) split without blocking pi's TUI.

`split-editor` replaces pi's blocking Ctrl+G external-editor workflow. Press
Ctrl+G in pi's prompt editor to open the current prompt in your editor (`nvim`
by default) in an adjacent pane. When the editor exits, the edited text is read back
into pi's prompt.

Pi stays visible and resize-aware in the original pane while the split is open.
The prompt is locked during editing so it cannot be mutated in two places at
once.

## Demo

https://github.com/user-attachments/assets/47a81b03-8292-45b9-8c85-508719c5f585

## Requirements

- pi
- tmux, or Superlogical Rex with the `rex` CLI on `PATH` and support for `split --wait`
- `nvim` by default; set the `editor` option to use a different terminal editor
  (see [Configuration](#configuration))

## Installation

From npm:

```bash
pi install git:github.com/TxHawks/split-editor
```

For development:

```bash
pi -e .
```

## Usage

1. Start pi in a tmux or Rex pane with this package loaded.
2. Type a prompt.
3. Press Ctrl+G.
4. Edit in the new split.
5. Save and quit the editor.
6. The edited text replaces the pi prompt.

Pressing Ctrl+G again while the split editor is already open will not open a
second editor.

## Configuration

Configuration is read each time Ctrl+G opens the split editor, so file/env
changes are picked up without reloading the extension.

Options:

| Option          | Env var                       | Default | Description                                                       |
| --------------- | ----------------------------- | ------- | ----------------------------------------------------------------- |
| `editor`        | `SPLIT_EDITOR_EDITOR`         | `nvim`  | Editor command to run in the new pane.                            |
| `size`          | `SPLIT_EDITOR_SIZE`           | `50%`   | New pane size: `1%`–`99%` in Rex, `split-window -l` size in tmux. |
| `direction`     | `SPLIT_EDITOR_DIRECTION`      | `h`     | `h`/`horizontal` for side-by-side, `v`/`vertical` for top/bottom. |
| `showIndicator` | `SPLIT_EDITOR_SHOW_INDICATOR` | `true`  | Show `SPLIT EDITOR OPEN` in the editor border while locked.       |

Precedence, lowest to highest:

1. Defaults
2. Global config: `~/.pi/agent/extensions/split-editor.json`
3. Global pi settings: `~/.pi/agent/settings.json` under `splitEditor`
4. Project config: `.pi/split-editor.json`
5. Project pi settings: `.pi/settings.json` under `splitEditor`
6. Environment variables

Standalone config files use the options directly:

```json
{
  "editor": "nvim",
  "size": "50%",
  "direction": "horizontal",
  "showIndicator": true
}
```

Pi `settings.json` uses a `splitEditor` object:

```json
{
  "splitEditor": {
    "editor": "nvim",
    "size": "50%",
    "direction": "vertical",
    "showIndicator": false
  }
}
```

Environment example:

```bash
SPLIT_EDITOR_EDITOR="nvim" \
SPLIT_EDITOR_SIZE=50% \
SPLIT_EDITOR_DIRECTION=h \
SPLIT_EDITOR_SHOW_INDICATOR=false \
pi
```

`SPLIT_EDITOR_SHOW_INDICATOR` accepts `1`, `true`, `yes`, `on`, `0`, `false`,
`no`, or `off`.

## Notes and limitations

- No backend setting is needed. If `$TMUX` is set (including inside Rex), pi
  uses tmux. Otherwise, `$REX_SESSION` and `$REX_BLOCK` identify the Rex pane
  to split. Outside either environment, Ctrl+G uses pi's default external editor.
- The pi prompt editor ignores input while the split editor is open.
- If the editor exits non-zero, the temp file is still read back into pi and a
  warning is shown.
- Temporary files are removed on a best-effort basis after the editor closes.
