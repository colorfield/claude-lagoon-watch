# Development

## Layout

| Path | Role |
|---|---|
| `hooks/register.tsx` | Everything that uses the mod API (`$`): session start, `/lagoon`, the Bash hook, polling, the pane |
| `hooks/lagoon.ts` | Pure logic: the GraphQL query, project and environment mapping, routes, shell command parsing, credential stripping |
| `hooks/status.ts` | Pure logic: the Statuspage summary, cluster matching, maintenance windows |
| `types/index.d.ts` | The mod's own types (state shapes) |
| `tests/lagoon-watch.test.tsx` | Tests for the pure modules and the registered hooks |

## Checks

```
claude plugin validate .
claude plugin test .
```

Fixtures use made-up names only (`acme`, `globex`, `example.com`): never a real client's project, route or build.

A bug fix comes with a test that fails when the bug is reintroduced; check it by reintroducing the bug temporarily.

## Mod API constraints

- `$` does not cross an import: pure code lives in separate files, tested directly; code that uses `$` stays in `register.tsx`.
- What the pane shows lives in `$.state` (through `atom`), not in module variables, so every change redraws it. Module variables hold pacing only.
- Work nobody awaits goes through `background()`.
- A command or hook never waits on a network read.

## Release

Bump `version` in `.claude-plugin/plugin.json`, commit, push to `main`. Users get it with `claude plugin update`.
