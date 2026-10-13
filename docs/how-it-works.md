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
| `lagoon raw --raw '{ projectByGitUrl(gitUrl: "…") { name } }'` | No `project:` in `.lagoon.yml`, none chosen | Find the project from the git remote |
| `lagoon raw --raw '{ me { email } }'` | Every form of the remote was refused | Tell "no such project" from a CLI that cannot answer |
| `lagoon raw --raw '{ projectByName(name: "…") { name gitUrl } }'` | A name the repo's files suggest, or one you set | Check the project exists, and whether it builds from this repo |
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

The repo's name is never taken for the project's: `acme_site` may deploy to `acme-site`, or to something else entirely. In order:

1. `project:` at the top level of `.lagoon.yml` in the session's root.
2. The project you set for this repo with `/lagoon <project>`. It is kept across sessions, per repository (its git remote, so every worktree shares it), and the pane marks it `(set by /lagoon)`. `/lagoon --forget` unsets it.
3. The git remote, with any credentials stripped (`https://user:token@…`, `ssh://user:password@…`), tried as written and in its other form (SSH ↔ https), against `projectByGitUrl`. Lagoon answers a URL it does not know with an error (`Cannot read properties of undefined (reading 'id')`), not `null`, so a refused form does not stop the next one.
4. Names the repo's files suggest, each checked with `projectByName`:
   - a Drush site alias, `drush/sites/*.site.yml` at the root or up to two folders down (`apps/cms/drush/sites`): `user: <project>-${env-name}`;
   - `LAGOON_PROJECT` in `docker-compose.yml` (or `compose.yml`), `.env`, `.lagoon.env`, a `${VAR:-default}` giving its default;
   - the repository's name in the git remote.

   Each is spelled as Lagoon would (`acme_site` → `acme-site`). One is taken only when Lagoon gives its git URL as this repo's (any spelling: SSH, `ssh://`, https, with or without `.git`). A compose file's `LAGOON_PROJECT` is often the local project's name, so a name is never taken on the files' word alone.
5. Otherwise the pane says no project was found and offers the names Lagoon has (`Maybe acme-site (repository name)`): **Choose project** (`p`) asks which one, or lets you type another; `/lagoon` asks at once. A name you give is checked with Lagoon before it is kept. With nothing to offer, `/lagoon <project>` sets it. The lookup runs again every 10 min.

A failed lookup (CLI error, not logged in) is an error to retry, never taken as "no project": when every form of the remote is refused, `{ me { email } }` tells which. After a `/cd` to another repo, the project is looked up again, and the previous project's data is never shown for the new one.

Drupal settings files are not read: they are PHP, and the project name in them is either read from the `LAGOON_PROJECT` environment variable at runtime or part of a hostname.

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
