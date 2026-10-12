# How it works

## Lagoon CLI or Lagoon API?

Both: the data comes from the Lagoon **GraphQL API**, always read **through the Lagoon CLI** (`lagoon raw --raw '<query>'`), never over HTTP by the mod itself.

- The mod has no token or auth handling of its own: it reuses whatever the `lagoon` CLI is logged in with (`lagoon login`, with an SSH key added to your Lagoon account).
- It talks to the CLI's default instance (`lagoon config current`).
- Every CLI call runs in the background with a 45 s timeout; a command or the pane never waits on it.

The only direct HTTP request goes to the platform status page (see [Platform status](#platform-status)), which is not part of Lagoon.

## Commands it runs

| Command | When | Why |
|---|---|---|
| `lagoon raw --raw '{ projectByGitUrl(gitUrl: "…") { name } }'` | No `project:` in `.lagoon.yml` | Find the project from the git remote |
| `lagoon raw --raw '<project query>'` | Each read | Environments, latest builds, routes, and who you are |
| `lagoon config current` | Each read (local, no network) | The instance shown next to your identity |
| `git branch --show-current` | Each read | Mark the current branch's environment |

The project query, in full ([`hooks/lagoon.ts`](../hooks/lagoon.ts)):

```graphql
{
  me { email }
  projectByName(name: "<project>") {
    name productionEnvironment standbyProductionEnvironment routerPattern
    environments {
      name environmentType deployType deployBaseRef deployHeadRef deployTitle route routes
      kubernetes { name routerPattern }
      deployments(limit: 1) { name status buildStep created started completed uiLink }
    }
  }
}
```

Values spliced into a query are checked first: a project name must match `^[a-z0-9][a-z0-9-]*$`, and a git URL is limited to URL characters.

## Finding the project

1. `project:` at the top level of `.lagoon.yml` in the session's root.
2. Otherwise the git remote, with any credentials stripped (`https://user:token@…`, `ssh://user:password@…`), tried as written and in its other form (SSH ↔ https), against `projectByGitUrl`.
3. No match: the pane says so, and the lookup runs again every 10 min.

A failed lookup (CLI error, not logged in) is an error to retry, never taken as "no project". After a `/cd` to another repo, the project is looked up again, and the previous project's data is never shown for the new one.

## What the pane shows

- **Environments**: the current branch's environment first, then production, then the most recently built. The current one, and any building, show in full: build step and duration, a link to the build log, and links to its services. The others take one line each.
- **Current environment**: the one whose branch (or pull request head) is the checked-out branch, or whose name is the branch's Lagoon slug.
- **Production**: `productionEnvironment`, `standbyProductionEnvironment`, or type `production`; drawn in red.
- **Services**: the routes `.lagoon.yml` names, or every route when it names none. A route Lagoon generated (`<service>.<env>.<project>.<cluster>`, from the router pattern) is hidden when a canonical route carries the same service name.
- **Last Claude command**: the latest Bash command Claude ran against one of this project's environments (`lagoon … -e <env>`, or `drush @lagoon.<project>-<env> …`), with its outcome; red when it targeted production.
- **Identity**: the Lagoon user the CLI acts as (`me { email }`) and the instance, or how to log in when the CLI is refused.
- **Dashboard**: a link to the project in the Lagoon UI, derived from a build link.

Only `http(s)` links from the API or the status page are drawn clickable.

## Polling

| Situation | Next read |
|---|---|
| A build is running | 20 s |
| Within 15 min after Claude ran `git push` or `lagoon deploy` (builds start from a webhook, a little later) | 20 s |
| Otherwise, or after an error | 3 min |
| No Lagoon project for this repo | 10 min |
| Status page | 5 min |

Refresh (`r` in the pane) reads now. A `lagoon login` run by Claude also triggers a read.

## Notifications

Builds are compared against the previous good read of the same project; the first read only sets the baseline.

- A build starts: a toast, and the pane opens (where the terminal is wide enough).
- A build completes, fails or is cancelled: a toast and a desktop notification, with the build log link.
- While builds run, the status line shows them: `Lagoon ● <env> <step> <duration>`.

## Platform status

When the `statusPage` option is set (default `https://status.amazee.io`, empty turns it off), the mod reads `<statusPage>/api/v2/summary.json`, a standard [Statuspage](https://www.atlassian.com/software/statuspage) summary:

- the overall status and open incidents;
- the project's cluster (e.g. `ch4.amazee.io` → component `ch4.lagoon`), its status and next maintenance window;
- every region's next window, on demand (`g`), with the project's region first.

Times show in the local time zone (`/etc/localtime`, else `TZ`).

## Known limits

- Only the CLI's default Lagoon instance is read; `-l <instance>` is not supported.
- The status page request has no timeout (the mod API offers none); a failed request is retried 5 min later.
