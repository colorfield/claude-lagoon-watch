# lagoon-watch

Claude Code mod that shows the [Lagoon](https://lagoon.sh) environments of the current project.

`/lagoon` opens a pane with each environment: running build (step, duration, build log link) or last build, and links to its services (canonical routes over generated ones). Builds that start or finish raise a notification; running ones show in the status line.

The project comes from `.lagoon.yml` (`project:`) or the git remote. Requires an authenticated [`lagoon`](https://github.com/uselagoon/lagoon-cli) CLI (default instance).

## Install

In Claude Code:

```
/plugin install lagoon-watch --marketplace colorfield/claude-lagoon-watch
```
