import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LagoonEnvironment, LagoonSnapshot } from '../types'
import { elapsed, environments, isProjectName, projectOf, QUERY, targetOf } from './lagoon'

// The Lagoon project the session's repo deploys to, through the lagoon CLI
// (its own SSH-based auth): each environment's latest build with a link to
// its log, and links to its services. Builds that start or settle are told
// in a toast and a notification, the running ones in the status line.

const PANE = 'lagoon-watch'
const snapshot = atom({ plugin: 'lagoon-watch', key: 'snapshot' } as const, null)
const target = atom({ plugin: 'lagoon-watch', key: 'target' } as const, null)

const TICK_MS = 10_000
const ACTIVE_MS = 20_000
const IDLE_MS = 180_000
// A push reaches Lagoon through a webhook: builds show up a little later.
const AFTER_PUSH_MS = 15 * 60_000

// The module's own pacing; a reload restarts it from session.start.
let nextAt = 0
let fastUntil = 0
let isFetching = false
// undefined: not looked up yet; null: the repo is no Lagoon project.
let project: string | null | undefined
// The root the project was looked up for: a /cd moves it, and the lookup with it.
let projectRoot: string | undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'lagoon', description: "Show the Lagoon environments, builds and services of this project" })
    project = undefined
    nextAt = 0
    $.clock.every(TICK_MS, () => void tick($))
    void tick($)
    return started
  })

  on('command.run', { command: 'lagoon' }, async $ => {
    nextAt = 0
    void tick($)
    const opened = await $.ui.open({ id: PANE, title: 'Lagoon' })
    return { text: opened.isPlaced ? 'Lagoon pane opened.' : 'Lagoon pane waits for a wider terminal.' }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (/\bgit\s+push\b|\blagoon\s+deploy\b/.test(e.command)) {
      fastUntil = (await $.clock.now()) + AFTER_PUSH_MS
      nextAt = 0
      void tick($)
    }
    const environment = typeof project === 'string' ? targetOf(e.command, project) : undefined
    if (environment !== undefined) {
      const at = await $.clock.now()
      await update($, target, () => ({ environment, command: e.command.slice(0, 200), at }))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const current = await read($, snapshot)
    const touched = await read($, target)
    const now = await $.clock.now()

    if (project === null) return <Text dimColor>No .lagoon.yml here, and the git remote matches no Lagoon project.</Text>
    if (current === null) return <Text dimColor>Reading Lagoon…</Text>

    const dashboard = dashboardOf(current)
    const room = Math.max(1, Math.floor(((e.viewport?.rows ?? 30) - 6) / 3))
    const shown = current.environments.slice(0, room)

    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text bold>{current.project}</Text>
          {dashboard !== undefined && <Text> <Link href={dashboard} label="dashboard" /></Text>}
          <Text dimColor> · {elapsed(current.fetchedAt, now)} ago</Text>
        </Text>
        {touched !== null && (
          <Text wrap="truncate-end" color={isProduction(current, touched.environment) ? 'error' : undefined}>
            ◆ Claude's last Lagoon command: {touched.environment} ({elapsed(touched.at, now)} ago)
          </Text>
        )}
        {current.error !== undefined && <Text color="warning" wrap="truncate-end">lagoon: {current.error}</Text>}
        {shown.map(env => (
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
        {current.environments.length > shown.length && (
          <Text dimColor>… {current.environments.length - shown.length} more environments</Text>
        )}
        <Box marginTop={1}>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => { nextAt = 0; void tick($) }} />
        </Box>
      </Box>
    )
  })
}

async function tick($: EngineInterface) {
  const now = await $.clock.now()
  const root = await $.session.root()
  if (root !== projectRoot) {
    projectRoot = root
    project = undefined
    nextAt = 0
  }
  if (isFetching || now < nextAt) return
  isFetching = true
  try {
    const lagoonYml = await readText($, `${root}/.lagoon.yml`)
    if (project === undefined) project = await projectFor($, lagoonYml)
    if (project === null) {
      nextAt = Number.POSITIVE_INFINITY
      return
    }

    const previous = await read($, snapshot)
    const fresh = await fetchSnapshot($, project, lagoonYml, previous, now)
    await update($, snapshot, () => fresh)
    await announce($, previous, fresh, now)
    const isActive = fresh.environments.some(env => env.build?.state === 'active')
    nextAt = now + (isActive || now < fastUntil ? ACTIVE_MS : IDLE_MS)
  } catch {
    nextAt = now + IDLE_MS
  } finally {
    isFetching = false
  }
}

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  return (await $.fs.exists(path)) ? $.fs.read(path) : undefined
}

// .lagoon.yml's `project:` first; else the project whose git URL is origin's.
async function projectFor($: EngineInterface, lagoonYml: string | undefined): Promise<string | null> {
  const named = lagoonYml === undefined ? undefined : projectOf(lagoonYml)
  if (named !== undefined) return named

  const repo = await $.session.repo()
  if (repo?.remote == null || !/^[\w@:/.+-]+$/.test(repo.remote)) return null
  const { exitCode, stdout } = await $.process.run(
    ['lagoon', 'raw', '--raw', `{ projectByGitUrl(gitUrl: "${repo.remote}") { name } }`],
    { timeoutMs: 45_000 },
  )
  if (exitCode !== 0) return null
  const name = (JSON.parse(stdout) as { projectByGitUrl?: { name?: string } | null }).projectByGitUrl?.name
  return name !== undefined && isProjectName(name) ? name : null
}

async function fetchSnapshot(
  $: EngineInterface,
  name: string,
  lagoonYml: string | undefined,
  previous: LagoonSnapshot | null,
  now: number,
): Promise<LagoonSnapshot> {
  if (!isProjectName(name)) return { project: name, environments: [], fetchedAt: now, error: 'not a Lagoon project name' }

  const [ran, branch] = await Promise.all([
    $.process.run(['lagoon', 'raw', '--raw', QUERY(name)], { timeoutMs: 45_000 }),
    currentBranch($),
  ])
  if (ran.exitCode !== 0) {
    const error = ran.stderr.trim().split('\n')[0]?.slice(0, 200) || 'lagoon raw failed'
    return previous === null ? { project: name, environments: [], fetchedAt: now, error } : { ...previous, error }
  }
  const data = JSON.parse(ran.stdout) as { projectByName: Parameters<typeof environments>[0] | null }
  if (data.projectByName === null) return { project: name, environments: [], fetchedAt: now, error: `no Lagoon project "${name}"` }
  return { project: name, environments: environments(data.projectByName, branch, lagoonYml), fetchedAt: now, error: undefined }
}

async function currentBranch($: EngineInterface): Promise<string | undefined> {
  const { exitCode, stdout } = await $.process.run(['git', 'branch', '--show-current'], { timeoutMs: 5000 })
  const branch = stdout.trim()
  return exitCode === 0 && branch !== '' ? branch : undefined
}

async function announce($: EngineInterface, previous: LagoonSnapshot | null, fresh: LagoonSnapshot, now: number) {
  const active = fresh.environments.filter(env => env.build?.state === 'active')
  $.ui.status(active.length === 0
    ? undefined
    : `Lagoon ● ${active.map(env => `${env.name} ${env.build?.step ?? env.build?.status} ${elapsed(env.build?.startedAt ?? env.build?.createdAt, now)}`).join(' · ')}`)

  // The first read only sets the baseline; a failed read settles nothing.
  if (previous === null || previous.project !== fresh.project || fresh.error !== undefined) return

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
