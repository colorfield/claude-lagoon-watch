# lagoon-watch

Claude Code mod that shows the [Lagoon](https://lagoon.sh) environments of the current project.

`/lagoon` opens a pane: the current branch's environment in full (build step, duration, build log, services), the others one line each, the Lagoon user the CLI acts as (with how to log in when it cannot), and the platform's [Statuspage](https://status.amazee.io) status with the project cluster's next maintenance window and every region's on demand. Builds that start or finish raise a notification; running ones show in the status line.

The project comes from `.lagoon.yml` (`project:`) or the git remote. Requires an authenticated [`lagoon`](https://github.com/uselagoon/lagoon-cli) CLI (default instance). Set another status page, or none, with the `statusPage` option in `/config`.

## Install

In Claude Code:

```
/plugin install lagoon-watch --marketplace colorfield/claude-lagoon-watch
```
