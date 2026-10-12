import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LagoonEnvironment, LagoonIdentity, LagoonLookup, LagoonPlatform, LagoonSnapshot } from '../types'
import {
  elapsed,
  environments,
  failedRead,
  firstLine,
  isBaseline,
  isLoginError,
  isProjectName,
  parseRaw,
  projectOf,
  QUERY,
  targetOf,
} from './lagoon'
import { componentText, INDICATOR, platform as readPlatform, windowText, zoneOf } from './status'

// The Lagoon project the session's repo deploys to, through the lagoon CLI
// (its own SSH-based auth): each environment's latest build with a link to
// its log, and links to its services; who the CLI acts as; and the hosting
// platform's status page. Builds that start or settle are told in a toast
// and a notification, the running ones in the status line.

const PANE = 'lagoon-watch'
// Everything the pane draws from is state, so every change redraws it.
const lookup = atom({ plugin: 'lagoon-watch', key: 'lookup' } as const, null)
const snapshot = atom({ plugin: 'lagoon-watch', key: 'snapshot' } as const, null)
const target = atom({ plugin: 'lagoon-watch', key: 'target' } as const, null)
const identity = atom({ plugin: 'lagoon-watch', key: 'identity' } as const, null)
const platform = atom({ plugin: 'lagoon-watch', key: 'platform' } as const, null)
const isShowingRegions = atom({ plugin: 'lagoon-watch', key: 'isShowingRegions' } as const, false)

const TICK_MS = 10_000
const ACTIVE_MS = 20_000
const IDLE_MS = 180_000
const STATUS_MS = 300_000
// A push reaches Lagoon through a webhook: builds show up a little later.
const AFTER_PUSH_MS = 15 * 60_000

const LOGIN_HINT = 'Run `lagoon login`; your SSH public key must be added to your Lagoon account (dashboard → Settings → SSH keys).'

// Pacing only; what is known lives in state. A reload restarts it from
// session.start.
let nextAt = 0
let nextStatusAt = 0
let fastUntil = 0
let isFetching = false
let isFetchingStatus = false
// A refresh asked for while a read runs: it runs once that read ends.
let isRefreshQueued = false
// Bumped when the session's root moves: a read started for another root
// writes nothing.
let generation = 0
// The status page to read ('' turns it off), the cluster it was last read
// for, and the zone its times show in.
let statusPage = ''
let statusCluster: string | undefined
let timeZone: string | undefined

export const register: Register = (on, options) => {
  statusPage = typeof options.statusPage === 'string' ? options.statusPage.replace(/\/+$/, '') : ''

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'lagoon', description: 'Show the Lagoon environments, builds and services of this project' })
    timeZone = await localZone($)
    nextAt = 0
    nextStatusAt = 0
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
    if (/\blagoon\s+login\b/.test(e.command)) await refresh($)
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
    const who = await read($, identity)
    const status = await read($, platform)
    const isExpanded = await read($, isShowingRegions)
    const now = await $.clock.now()

    const refreshButton = <Button key="refresh" label="Refresh" hotkey="r" onPress={() => refresh($)} />

    const identityLine = who === null
      ? null
      : who.email !== undefined
        ? <Text dimColor wrap="truncate-end">{who.email}{who.instance === undefined ? '' : ` · ${who.instance}`}</Text>
        : (
          <Box flexDirection="column">
            <Text color="warning" wrap="truncate-end">
              ⚠ {who.isLoggedOut ? 'Not logged in to Lagoon' : 'Lagoon identity unknown'}{who.instance === undefined ? '' : ` (${who.instance})`}
            </Text>
            {who.isLoggedOut && <Text dimColor wrap="wrap">  {LOGIN_HINT}</Text>}
          </Box>
        )

    const platformBlock = status === null ? null : (
      <Box flexDirection="column">
        {status.error !== undefined
          ? <Text color="warning" wrap="truncate-end">⚠ {status.url}: {status.error}</Text>
          : (
            <Text wrap="truncate-end">
              <Text color={(INDICATOR[status.indicator] ?? INDICATOR.minor!).color}>{(INDICATOR[status.indicator] ?? INDICATOR.minor!).icon}</Text>
              {' '}<Link href={status.url} label={status.name} />: {status.description}
            </Text>
          )}
        {status.incidents.map(incident => (
          <Text key={incident.name} color="error" wrap="truncate-end">
            {'  '}! {incident.url === undefined ? incident.name : <Link href={incident.url} label={incident.name} />}
          </Text>
        ))}
        {status.cluster !== undefined && (
          <Text wrap="truncate-end">
            {'  '}{status.cluster.name} <Text dimColor>(this project)</Text>:{' '}
            {status.cluster.status === 'operational' ? '' : <Text color="warning">{componentText(status.cluster.status)} · </Text>}
            {status.cluster.next === undefined
              ? <Text dimColor>no maintenance planned</Text>
              : <Text color={status.cluster.next.isInProgress ? 'warning' : undefined}>maintenance {windowText(status.cluster.next, timeZone)}</Text>}
          </Text>
        )}
        {status.regions.length > 0 && (
          <Box marginLeft={2}>
            <Button
              key="regions"
              label={isExpanded ? 'Hide regions' : 'Regions'}
              hotkey="g"
              onPress={() => update($, isShowingRegions, value => !value)}
            />
          </Box>
        )}
        {isExpanded && regionRows(status).map(row => (
          <Text key={row.name} wrap="truncate-end">
            {'  '}{row.name.padEnd(row.width)}{' '}
            {row.next === undefined
              ? <Text dimColor>none planned</Text>
              : row.next.url === undefined
                ? <Text color={row.next.isInProgress ? 'warning' : undefined}>{windowText(row.next, timeZone)}</Text>
                : <Link href={row.next.url} label={windowText(row.next, timeZone)} />}
          </Text>
        ))}
      </Box>
    )

    const footer = (
      <Box flexDirection="column" marginTop={1}>
        {platformBlock}
        {identityLine}
      </Box>
    )

    if (found === null || found.status === 'pending') {
      return <Box flexDirection="column"><Text dimColor>Reading Lagoon…</Text>{footer}</Box>
    }
    if (found.status !== 'found') {
      return (
        <Box flexDirection="column">
          {found.status === 'none'
            ? <Text dimColor wrap="wrap">No .lagoon.yml here, and the git remote matches no Lagoon project.</Text>
            : <Text color="warning" wrap="wrap">Could not find the Lagoon project: {found.error}</Text>}
          <Box marginTop={1}>{refreshButton}</Box>
          {footer}
        </Box>
      )
    }

    // A snapshot of another project (before the first read after a /cd) is not shown.
    const current = stored?.project === found.project ? stored : null
    const dashboard = current === null ? undefined : dashboardOf(current)
    const list = current?.environments ?? []
    const width = Math.max(0, ...list.map(env => env.name.length))

    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Text wrap="truncate-end">
            <Text bold>{found.project}</Text>
            {dashboard !== undefined && <Text> · <Link href={dashboard} label="dashboard" /></Text>}
            {current?.fetchedAt !== undefined && <Text dimColor> · read {elapsed(current.fetchedAt, now)} ago</Text>}
          </Text>
          {refreshButton}
        </Box>
        {current?.error !== undefined && !(who?.isLoggedOut ?? false) && (
          <Text color="warning" wrap="truncate-end">lagoon: {current.error}</Text>
        )}
        {current === null && <Text dimColor>Reading Lagoon…</Text>}
        <Box flexDirection="column" marginTop={1}>
          {list.map(env => (isFocused(env) ? (
            <Box key={env.name} flexDirection="column">
              <Text wrap="truncate-end">
                <Text color="claude">{env.isCurrent ? '▸ ' : '  '}</Text>
                <Text bold color={env.isProduction ? 'error' : undefined}>{env.name.padEnd(width)}</Text>
                {'  '}{buildText(env, now)}
                {env.build?.url !== undefined && (
                  <Text> · <Link href={env.build.url} label={env.build.state === 'active' ? 'build log' : 'last build'} /></Text>
                )}
                {env.title !== undefined && <Text dimColor> · {env.title}</Text>}
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
          ) : (
            <Text key={env.name} wrap="truncate-end">
              {'  '}
              <Text color={env.isProduction ? 'error' : undefined}>{env.name.padEnd(width)}</Text>
              {'  '}{buildText(env, now)}
              {env.build?.url !== undefined && <Text> · <Link href={env.build.url} label="last build" /></Text>}
              {primaryOf(env) !== undefined && <Text> · <Link href={primaryOf(env)!.url} label={primaryOf(env)!.label} /></Text>}
            </Text>
          )))}
        </Box>
        {touched !== null && current !== null && (
          <Text wrap="truncate-end" color={isProduction(current, touched.environment) ? 'error' : 'subtle'}>
            ◆ Claude's last Lagoon command: {touched.environment} ({elapsed(touched.at, now)} ago)
          </Text>
        )}
        {footer}
      </Box>
    )
  })
}

// The rows shown in full: the current branch's environment, and any building.
function isFocused(env: LagoonEnvironment): boolean {
  return env.isCurrent || env.build?.state === 'active'
}

function primaryOf(env: LagoonEnvironment) {
  return env.services.find(service => service.isPrimary) ?? env.services[0]
}

// The project's region first, marked; the others by their next window.
function regionRows(status: LagoonPlatform) {
  const home = status.cluster?.region
  const rows = status.regions
    .map(region => ({ name: region.name === home ? `${region.name} ◆` : region.name, next: region.next, isHome: region.name === home }))
    .sort((a, b) => Number(b.isHome) - Number(a.isHome) || (a.next?.from ?? Infinity) - (b.next?.from ?? Infinity))
  const width = Math.max(0, ...rows.map(row => row.name.length))
  return rows.map(row => ({ ...row, width }))
}

// An explicit refresh: reads now, or right after the read in flight; a
// project that could not be found is looked up again, the status page too.
async function refresh($: EngineInterface) {
  const found = await read($, lookup)
  if (found !== null && found.status !== 'found' && found.status !== 'pending') {
    const pending: LagoonLookup = { root: found.root, status: 'pending' }
    await update($, lookup, () => pending)
  }
  nextAt = 0
  nextStatusAt = 0
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
    nextStatusAt = 0
    $.ui.status(undefined)
    const pending: LagoonLookup = { root, status: 'pending' }
    await update($, lookup, () => pending)
  }
  void pollPlatform($, now)
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
  const { fresh, email, cliError } = await readProject($, found.project, lagoonYml, previous, now)
  if (started !== generation) return 0
  await update($, snapshot, () => fresh)
  // The status page was read for another cluster (or none yet): read it again.
  if (clusterOf(fresh) !== statusCluster) {
    nextStatusAt = 0
    void pollPlatform($, now)
  }
  await noteIdentity($, email, cliError)
  announce($, previous, fresh, now)
  const isActive = fresh.environments.some(env => env.build?.state === 'active')
  return now + (isActive || now < fastUntil ? ACTIVE_MS : IDLE_MS)
}

// Who the CLI acts as: the `me` of the last read, or why it could not say.
async function noteIdentity($: EngineInterface, email: string | undefined, cliError: string | undefined) {
  const known = await read($, identity)
  const instance = known?.instance ?? await currentInstance($)
  const next: LagoonIdentity = email !== undefined
    ? { instance, email, error: undefined, isLoggedOut: false }
    : cliError !== undefined
      ? { instance, email: undefined, error: cliError, isLoggedOut: isLoginError(cliError) }
      : { instance, email: known?.email, error: undefined, isLoggedOut: false }
  await update($, identity, () => next)
}

async function currentInstance($: EngineInterface): Promise<string | undefined> {
  const ran = await lagoon($, ['config', 'current'])
  return 'error' in ran ? undefined : firstLine(ran.stdout) || undefined
}

// The status page, every five minutes, for the cluster the project runs on.
async function pollPlatform($: EngineInterface, now: number) {
  if (statusPage === '' || isFetchingStatus || now < nextStatusAt) return
  isFetchingStatus = true
  nextStatusAt = now + STATUS_MS
  try {
    const cluster = clusterOf(await read($, snapshot))
    statusCluster = cluster
    const previous = await read($, platform)
    let next: LagoonPlatform
    try {
      const response = await $.http.fetch(`${statusPage}/api/v2/summary.json`)
      next = response.ok
        ? readPlatform(response.text, cluster, now)
        : failedPlatform(previous, `HTTP ${response.status}`, now)
    } catch (error) {
      next = failedPlatform(previous, message(error), now)
    }
    await update($, platform, () => next)
  } finally {
    isFetchingStatus = false
  }
}

function failedPlatform(previous: LagoonPlatform | null, error: string, now: number): LagoonPlatform {
  return previous === null
    ? { name: statusPage, url: statusPage, indicator: 'minor', description: '', incidents: [], cluster: undefined, regions: [], fetchedAt: now, error }
    : { ...previous, error }
}

// The cluster of the current branch's environment, else production's, else any known.
function clusterOf(stored: LagoonSnapshot | null): string | undefined {
  const list = stored?.environments ?? []
  return list.find(env => env.isCurrent)?.cluster
    ?? list.find(env => env.isProduction)?.cluster
    ?? list.find(env => env.cluster !== undefined)?.cluster
}

async function localZone($: EngineInterface): Promise<string | undefined> {
  try {
    const zone = zoneOf((await $.fs.stat('/etc/localtime', { resolve: true })).realPath)
    if (zone !== undefined) return zone
  } catch {}
  return (await $.env.get('TZ')) || undefined
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
  if ('error' in ran) {
    await noteIdentity($, undefined, ran.error)
    return { root, status: 'error', error: ran.error }
  }
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

type ProjectRead = { fresh: LagoonSnapshot; email: string | undefined; cliError: string | undefined }

async function readProject(
  $: EngineInterface,
  name: string,
  lagoonYml: string | undefined,
  previous: LagoonSnapshot | null,
  now: number,
): Promise<ProjectRead> {
  const failed = (error: string, cliError?: string): ProjectRead =>
    ({ fresh: failedRead(previous, name, error), email: undefined, cliError })
  if (!isProjectName(name)) return failed('not a Lagoon project name')

  const [ran, branch] = await Promise.all([lagoon($, ['raw', '--raw', QUERY(name)]), currentBranch($)])
  if ('error' in ran) return failed(ran.error, ran.error)
  try {
    const answer = parseRaw(ran.stdout)
    const email = (answer.me as { email?: unknown } | null | undefined)?.email
    const data = answer.projectByName as Parameters<typeof environments>[0] | null | undefined
    const who = typeof email === 'string' ? email : undefined
    if (data === null) return { ...failed(`no Lagoon project "${name}" (or no access)`), email: who }
    if (data === undefined || !Array.isArray(data.environments)) return { ...failed('unexpected answer to projectByName'), email: who }
    return { fresh: { project: name, environments: environments(data, branch, lagoonYml), fetchedAt: now, error: undefined }, email: who, cliError: undefined }
  } catch (error) {
    return failed(message(error))
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

// "● applyingDeployments · 4m09s" while it runs; "✓ 3d ago in 23m20s" once settled.
function buildText(env: LagoonEnvironment, now: number): string {
  const build = env.build
  if (build === undefined) return '○ no build yet'
  if (build.state === 'active') {
    return `● ${build.step ?? build.status} · ${elapsed(build.startedAt ?? build.createdAt, now)}`
  }
  const icon = build.state === 'complete' ? '✓' : build.state === 'cancelled' ? '⊘' : '✗'
  const what = build.state === 'complete' ? '' : ` ${build.status}`
  const took = build.completedAt === undefined ? '' : ` in ${elapsed(build.startedAt ?? build.createdAt, build.completedAt)}`
  return `${icon}${what} ${elapsed(build.completedAt ?? build.createdAt, now)} ago${took}`
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
