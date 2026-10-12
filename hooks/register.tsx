import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LagoonEnvironment, LagoonLookup, LagoonSnapshot } from '../types'
import {
  elapsed,
  environments,
  failedRead,
  firstLine,
  isBaseline,
  isProjectName,
  parseRaw,
  projectOf,
  QUERY,
  targetOf,
} from './lagoon'

// The Lagoon project the session's repo deploys to, through the lagoon CLI
// (its own SSH-based auth): each environment's latest build with a link to
// its log, and links to its services. Builds that start or settle are told
// in a toast and a notification, the running ones in the status line.

const PANE = 'lagoon-watch'
// Everything the pane draws from is state, so every change redraws it.
const lookup = atom({ plugin: 'lagoon-watch', key: 'lookup' } as const, null)
const snapshot = atom({ plugin: 'lagoon-watch', key: 'snapshot' } as const, null)
const target = atom({ plugin: 'lagoon-watch', key: 'target' } as const, null)

const TICK_MS = 10_000
const ACTIVE_MS = 20_000
const IDLE_MS = 180_000
// A push reaches Lagoon through a webhook: builds show up a little later.
const AFTER_PUSH_MS = 15 * 60_000

// Pacing only; what is known lives in state. A reload restarts it from
// session.start.
let nextAt = 0
let fastUntil = 0
let isFetching = false
// A refresh asked for while a read runs: it runs once that read ends.
let isRefreshQueued = false
// Bumped when the session's root moves: a read started for another root
// writes nothing.
let generation = 0

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'lagoon', description: 'Show the Lagoon environments, builds and services of this project' })
    nextAt = 0
    // Polls when due, and redraws the pane so its "ago" and durations move.
    $.clock.every(TICK_MS, () => {
      $.ui.invalidate('ui.render')
      void tick($)
    })
    void tick($)
    return started
  })

  on('command.run', { command: 'lagoon' }, async $ => {
    await refresh($)
    const opened = await $.ui.open({ id: PANE, title: 'Lagoon' })
    return { text: opened.isPlaced ? 'Lagoon pane opened.' : 'Lagoon pane waits for a wider terminal.' }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (/\bgit\s+push\b|\blagoon\s+deploy\b/.test(e.command)) {
      fastUntil = (await $.clock.now()) + AFTER_PUSH_MS
      await refresh($)
    }
    const found = await read($, lookup)
    const environment = found?.status === 'found' ? targetOf(e.command, found.project) : undefined
    if (environment !== undefined) {
      const at = await $.clock.now()
      await update($, target, () => ({ environment, command: e.command.slice(0, 200), at }))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const found = await read($, lookup)
    const stored = await read($, snapshot)
    const touched = await read($, target)
    const now = await $.clock.now()
    const refreshButton = <Button key="refresh" label="Refresh" hotkey="r" onPress={() => refresh($)} />

    if (found === null || found.status === 'pending') return <Text dimColor>Reading Lagoon…</Text>
    if (found.status === 'none') {
      return (
        <Box flexDirection="column">
          <Text dimColor>No .lagoon.yml here, and the git remote matches no Lagoon project.</Text>
          <Box marginTop={1}>{refreshButton}</Box>
        </Box>
      )
    }
    if (found.status === 'error') {
      return (
        <Box flexDirection="column">
          <Text color="warning" wrap="wrap">Could not find the Lagoon project: {found.error}</Text>
          <Box marginTop={1}>{refreshButton}</Box>
        </Box>
      )
    }

    // A snapshot of another project (before the first read after a /cd) is not shown.
    const current = stored?.project === found.project ? stored : null
    const dashboard = current === null ? undefined : dashboardOf(current)

    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Text wrap="truncate-end">
            <Text bold>{found.project}</Text>
            {dashboard !== undefined && <Text> <Link href={dashboard} label="dashboard" /></Text>}
            {current?.fetchedAt !== undefined && <Text dimColor> · read {elapsed(current.fetchedAt, now)} ago</Text>}
          </Text>
          {refreshButton}
        </Box>
        {touched !== null && current !== null && (
          <Text wrap="truncate-end" color={isProduction(current, touched.environment) ? 'error' : undefined}>
            ◆ Claude's last Lagoon command: {touched.environment} ({elapsed(touched.at, now)} ago)
          </Text>
        )}
        {current?.error !== undefined && <Text color="warning" wrap="truncate-end">lagoon: {current.error}</Text>}
        {current === null && <Text dimColor>Reading Lagoon…</Text>}
        {/* Every environment: the pane scrolls, the header keeps Refresh in reach. */}
        {(current?.environments ?? []).map(env => (
          <Box key={env.name} flexDirection="column" marginTop={1}>
            <Text wrap="truncate-end">
              <Text color={env.isCurrent ? 'claude' : undefined}>{env.isCurrent ? '▸ ' : '  '}</Text>
              <Text bold color={env.isProduction ? 'error' : undefined}>{env.name}</Text>
              {env.isProduction && <Text dimColor> production</Text>}
              {env.title !== undefined && <Text dimColor> {env.title}</Text>}
            </Text>
            <Text wrap="truncate-end">
              {'    '}{buildLine(env, now)}
              {env.build?.url !== undefined && (
                <Text> · <Link href={env.build.url} label={env.build.state === 'active' ? 'build log' : 'last build'} /></Text>
              )}
            </Text>
            {env.services.length > 0 && (
              <Text wrap="truncate-end">
                {'    '}
                {env.services.map((service, index) => (
                  <Text key={service.url}>{index > 0 ? ' · ' : ''}<Link href={service.url} label={service.label} /></Text>
                ))}
              </Text>
            )}
          </Box>
        ))}
      </Box>
    )
  })
}

// An explicit refresh: reads now, or right after the read in flight; a
// project that could not be found is looked up again.
async function refresh($: EngineInterface) {
  const found = await read($, lookup)
  if (found !== null && found.status !== 'found' && found.status !== 'pending') {
    const pending: LagoonLookup = { root: found.root, status: 'pending' }
    await update($, lookup, () => pending)
  }
  nextAt = 0
  if (isFetching) {
    isRefreshQueued = true
    return
  }
  await tick($)
}

async function tick($: EngineInterface) {
  const now = await $.clock.now()
  const root = await $.session.root()
  const known = await read($, lookup)
  if (known === null || known.root !== root) {
    generation += 1
    nextAt = 0
    $.ui.status(undefined)
    const pending: LagoonLookup = { root, status: 'pending' }
    await update($, lookup, () => pending)
  }
  if (isFetching || now < nextAt) return

  isFetching = true
  const started = generation
  try {
    nextAt = await poll($, root, started, now)
  } catch (error) {
    // Only the unforeseen lands here; the reads record their own failures.
    if (started === generation) {
      const failed: LagoonLookup = { root, status: 'error', error: message(error) }
      await update($, lookup, () => failed)
    }
    nextAt = now + IDLE_MS
  } finally {
    isFetching = false
    if (isRefreshQueued || started !== generation) {
      isRefreshQueued = false
      nextAt = 0
      void tick($)
    }
  }
}

// One round: find the project if needed, read it, tell what changed.
// Resolves when the next round is due.
async function poll($: EngineInterface, root: string, started: number, now: number): Promise<number> {
  const lagoonYml = await readText($, `${root}/.lagoon.yml`)
  let found = await read($, lookup)
  if (found === null || found.status !== 'found') {
    const resolved = await projectFor($, root, lagoonYml)
    if (started !== generation) return 0
    await update($, lookup, () => resolved)
    found = resolved
  }
  if (found.status === 'none') {
    $.ui.status(undefined)
    return Number.POSITIVE_INFINITY
  }
  if (found.status !== 'found') {
    $.ui.status(undefined)
    return now + IDLE_MS
  }

  const previous = await read($, snapshot)
  const fresh = await readProject($, found.project, lagoonYml, previous, now)
  if (started !== generation) return 0
  await update($, snapshot, () => fresh)
  announce($, previous, fresh, now)
  const isActive = fresh.environments.some(env => env.build?.state === 'active')
  return now + (isActive || now < fastUntil ? ACTIVE_MS : IDLE_MS)
}

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  return (await $.fs.exists(path)) ? $.fs.read(path) : undefined
}

// .lagoon.yml's `project:` first; else the project whose git URL is origin's.
// A failed lookup is an error, retried, never taken for "no project".
async function projectFor($: EngineInterface, root: string, lagoonYml: string | undefined): Promise<LagoonLookup> {
  const named = lagoonYml === undefined ? undefined : projectOf(lagoonYml)
  if (named !== undefined) return { root, status: 'found', project: named }

  const repo = await $.session.repo()
  if (repo?.remote == null || !/^[\w@:/.+-]+$/.test(repo.remote)) return { root, status: 'none' }
  const ran = await lagoon($, ['raw', '--raw', `{ projectByGitUrl(gitUrl: "${repo.remote}") { name } }`])
  if ('error' in ran) return { root, status: 'error', error: ran.error }
  try {
    const answer = parseRaw(ran.stdout).projectByGitUrl as { name?: unknown } | null | undefined
    if (answer === null) return { root, status: 'none' }
    const name = answer?.name
    return typeof name === 'string' && isProjectName(name)
      ? { root, status: 'found', project: name }
      : { root, status: 'error', error: 'unexpected answer to projectByGitUrl' }
  } catch (error) {
    return { root, status: 'error', error: message(error) }
  }
}

async function readProject(
  $: EngineInterface,
  name: string,
  lagoonYml: string | undefined,
  previous: LagoonSnapshot | null,
  now: number,
): Promise<LagoonSnapshot> {
  if (!isProjectName(name)) return failedRead(previous, name, 'not a Lagoon project name')

  const [ran, branch] = await Promise.all([lagoon($, ['raw', '--raw', QUERY(name)]), currentBranch($)])
  if ('error' in ran) return failedRead(previous, name, ran.error)
  try {
    const data = parseRaw(ran.stdout).projectByName as Parameters<typeof environments>[0] | null | undefined
    if (data === null) return failedRead(previous, name, `no Lagoon project "${name}" (or no access)`)
    if (data === undefined || !Array.isArray(data.environments)) return failedRead(previous, name, 'unexpected answer to projectByName')
    return { project: name, environments: environments(data, branch, lagoonYml), fetchedAt: now, error: undefined }
  } catch (error) {
    return failedRead(previous, name, message(error))
  }
}

// Runs the lagoon CLI; a missing binary, a timeout or a non-zero exit is an
// `error` the pane can show.
async function lagoon($: EngineInterface, args: string[]): Promise<{ stdout: string } | { error: string }> {
  try {
    const { exitCode, stdout, stderr } = await $.process.run(['lagoon', ...args], { timeoutMs: 45_000 })
    return exitCode === 0 ? { stdout } : { error: firstLine(stderr) || firstLine(stdout) || `lagoon exited ${exitCode}` }
  } catch (error) {
    return { error: `lagoon CLI unavailable: ${message(error)}` }
  }
}

async function currentBranch($: EngineInterface): Promise<string | undefined> {
  try {
    const { exitCode, stdout } = await $.process.run(['git', 'branch', '--show-current'], { timeoutMs: 5000 })
    const branch = stdout.trim()
    return exitCode === 0 && branch !== '' ? branch : undefined
  } catch {
    return undefined
  }
}

function announce($: EngineInterface, previous: LagoonSnapshot | null, fresh: LagoonSnapshot, now: number) {
  const active = fresh.environments.filter(env => env.build?.state === 'active')
  $.ui.status(active.length === 0
    ? undefined
    : `Lagoon ● ${active.map(env => `${env.name} ${env.build?.step ?? env.build?.status} ${elapsed(env.build?.startedAt ?? env.build?.createdAt, now)}`).join(' · ')}`)

  if (!isBaseline(previous, fresh)) return

  for (const env of fresh.environments) {
    const build = env.build
    if (build === undefined) continue
    const before = previous.environments.find(one => one.name === env.name)?.build
    const isNew = before?.name !== build.name
    if (!isNew && before?.state === build.state) continue

    if (build.state === 'active') {
      if (!isNew) continue
      $.ui.toast(`Lagoon ${env.name}: build started`, { timeoutMs: 8000 })
      // Opened unasked, it shows only where the terminal is wide enough.
      void $.ui.open({ id: PANE, title: 'Lagoon' }).catch(() => undefined)
      continue
    }

    // A build that settled since the last read, seen running or not.
    const took = elapsed(build.startedAt ?? build.createdAt, build.completedAt ?? now)
    const text = build.state === 'complete'
      ? `Lagoon ${env.name}: build complete (${took})`
      : `Lagoon ${env.name}: build ${build.status}${build.step ? ` at ${build.step}` : ''} (${took})`
    $.ui.toast(text, { timeoutMs: 12_000 })
    void $.ui.notify(build.url === undefined ? text : `${text}\n${build.url}`, { title: 'Lagoon' }).catch(() => undefined)
  }
}

function buildLine(env: LagoonEnvironment, now: number): string {
  const build = env.build
  if (build === undefined) return '○ no build yet'
  if (build.state === 'active') {
    return `● ${build.status}${build.step ? ` · ${build.step}` : ''} · ${elapsed(build.startedAt ?? build.createdAt, now)}`
  }
  const icon = build.state === 'complete' ? '✓' : build.state === 'cancelled' ? '⊘' : '✗'
  const took = build.completedAt === undefined ? '' : ` in ${elapsed(build.startedAt ?? build.createdAt, build.completedAt)}`
  return `${icon} ${build.status} ${elapsed(build.completedAt ?? build.createdAt, now)} ago${took}`
}

// The dashboard's project page, from a build link: https://<ui>/projects/<project>.
function dashboardOf(current: LagoonSnapshot): string | undefined {
  for (const env of current.environments) {
    const match = /^(https?:\/\/[^/]+\/projects\/[^/]+)\//.exec(env.build?.url ?? '')
    if (match) return match[1]
  }
  return undefined
}

function isProduction(current: LagoonSnapshot, name: string): boolean {
  return current.environments.some(env => env.name === name && env.isProduction)
}

function message(error: unknown): string {
  return firstLine(error instanceof Error ? error.message : String(error)) || 'unknown error'
}
