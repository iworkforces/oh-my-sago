# oh-my-sago

`oh-my-sago` (`omsago`) is an OpenCode v2 server plugin that runs the installed
`oh-my-openagent` runtime through a compatibility bridge. It reuses OmO's agents,
prompts, tools, hooks, and managers rather than maintaining copies of them.

## Installation

Add `omsago` as a OpenCode v2 plugin:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["omsago@latest"]
}
```

Replace the example path with your checkout. Do not load `oh-my-openagent` or
`oh-my-opencode` alongside `omsago`; `omsago` starts OmO itself. Quit and restart
OpenCode after changing the plugin configuration. No global configuration is
changed by the build or tests, and this package has not been published by these
instructions.

OmO retains ownership of its own configuration and migrations. In its shared
`.omo/omo.json` or `.omo/omo.jsonc`, OpenCode engine settings belong under the
literal `[opencode]` key. For example:

```json
{
  "[opencode]": {
    "agents": {
      "sisyphus": { "model": "openai/gpt-6.2-astra" }
    }
  }
}
```

Select a model available in your OpenCode v2 installation. Provider credentials stay
with OpenCode v2; the bridge does not implement another authentication system.

## Implemented server behavior

- The public OmO `omoPlugin` factory supplies agents, commands, MCP configuration,
  custom tools, and lifecycle cleanup.
- Native domain registrations translate tool schemas, tool input/output hooks,
  permission checks, shell environment hooks, and legacy configuration changes.
  Tool execution still uses the original OmO validators.
- Session hooks adapt prompts, message and system transformations, generation
  parameters, request headers, and compaction context. Unchanged native media,
  signed reasoning, and provider metadata are retained.
- A generated legacy SDK client routes discovery, session operations, prompts,
  cancellation, status, messages, and compaction to native v2 APIs. Native events
  are translated for OmO's existing managers.
- OpenCode starts one plugin instance, and so one OmO runtime, per directory, but
  publishes every directory's session events on one bus. Each instance translates
  only its own directory's sessions, so one finished turn produces one
  `session.idle` and at most one todo-continuation countdown and prompt.
- An OpenCode v2 session can go idle while work it owns still runs, such as a
  background shell or a Code Mode script that outlived its call, and that
  work's notice wakes the session again. omsago holds back `session.idle` and
  keeps reporting the session busy until it goes idle with none of its own work
  left. Otherwise OmO would complete a background task early, then abort and
  delete its session while the subagent was still working.
- Native compaction start and failure reach OmO as
  `session.compaction.started` and `session.compaction.failed`. OmO's model
  fallback uses them to hold its timeout and error handling while a compaction
  runs, and to resume once it fails.
- OmO's `session_list`, `session_read`, and `session_search` tools first try a
  global SDK client at the plugin's `serverUrl`. omsago gives OmO a loopback
  address that answers every request with `NotFoundError`, so these tools fall
  back to the plugin client, which reads sessions from the native v2 APIs. All
  instances for one directory share that address, and it stays up for the
  reload hand-off window after the last of them closes. A runtime that was
  reloaded away therefore still reaches the plugin client rather than falling
  back to OmO's own file storage.
- Tools that OmO's configuration turns off in `tools`, such as `grep_app_*` or
  the task tools that its task system replaces, become native deny rules, so the
  model does not see them. OmO's per-agent permissions can still allow them.
- When OpenCode reloads the plugin, it closes the old instance before the new
  one finishes starting, while tool calls from a turn already under way can
  still be running in the old OmO runtime. A closed instance forwards those
  client calls to the newer instance for the same directory, waiting up to 10
  seconds for it to open, and fails with HTTP 503 only if none does. A late call
  from the old runtime therefore still takes effect: it can prompt or abort the
  session it names. The hand-off matches calls by method, path, headers, and
  body, not by omsago's internal client address, so instances of different
  omsago versions can hand calls to each other.

The native CLI integration suite exercises a real OmO agent turn and skill,
protected writes, synchronous delegation, background completion and failure,
interruption, and replacement/unload/reload. Models are deterministic local
fixtures; the tests do not use credentials or call a model service. A failed
background model can take about 30 seconds to settle because OmO's existing
manager confirms generic idle errors over multiple observations.

## Compatibility boundaries

There is no OmO TUI/sidebar export. Optional integrations such as workspace
adapters, tmux attachment, and UI notifications are not ported by this milestone.

The client facade is deliberately limited to implemented routes. Unsupported
legacy calls return an error, usually HTTP 501, rather than an empty successful
response. In particular, the legacy session-todo endpoint is unavailable: the v2
plugin context has no authoritative current-todo read API. Legacy history is
projected from the native context window, so it does not expose the full
pre-compaction archive.

OmO's configuration hook runs against a view that omsago builds from the native
v2 runtime, not against your merged `opencode.json`. That view carries only
agents, the selected model, and commands, so OmO never sees `mcp`,
`permission`, `default_agent`, `formatter`, or `skills`. OpenCode still
applies those fields natively, after OmO's, so your own settings take
precedence:

- Your `default_agent` stays the default when it names a primary agent. OmO
  turns `build` and `plan` into hidden subagents, so naming either one leaves
  OmO's default in place.
- Your permission rules come after OmO's per-agent rules, so a deny of yours,
  for example for `webfetch` or an `external_directory` path, overrides
  OmO's allow.
- An MCP server you define keeps your definition when OmO's configuration has
  one with the same name. omsago logs a warning and does not use OmO's.

OmO itself still does not see these fields. It does not use your formatters for
its own edits, and does not read the skill sources you declare in
configuration. Put the equivalent setting in OmO's own configuration when you
want OmO itself to follow it.

OmO keeps some clients in module-level state that the most recently started
instance replaces, including the client behind its session tools and its
background-task toasts. When one OpenCode process runs OmO for several
directories at once, those features can use the client of the directory that
started last. omsago cannot scope that state without changing OmO.

Some native events have no legacy translation. An interrupted turn reaches OmO
as a `session.error` with an abort, not as a separate stop event. Permission
requests, permission replies, and questions are not forwarded as events, so OmO
sends no desktop notification while a permission prompt waits; OmO still sees
questions through its tool hooks.

Commands support text templates, `$ARGUMENTS`, positional arguments, and
agent/model selection. Legacy command subtasks and shell/file expansion fail
explicitly. Native v2 features without a legacy equivalent, and legacy hooks
without a v2 equivalent such as compaction autocontinue, are not claimed as
compatible.

Development retains Effect 4.1.4. OpenCode supplies its own Effect and plugin
runtime instances when loading the plugin; do not bundle a second runtime into
the plugin. The integration suite uses that native loader rather than importing
an embedded host with a different dependency graph.

## Development

```sh
bun run typecheck
bun run lint
bun run format:check
bun run build
bun test
```

Tests isolate HOME, XDG directories, workspaces, subprocesses, and ephemeral
localhost ports. They close owned servers and remove temporary scenario roots.
`dist/` is generated by the build; the package exports both its root and `/server`
entry points from `dist/index.js`.

The bridge is MIT-licensed. `oh-my-openagent` remains a separate dependency under
its [Sustainable Use License](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/LICENSE.md);
this repository's license does not relicense upstream code.
