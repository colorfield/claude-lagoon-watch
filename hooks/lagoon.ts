import type { LagoonBuild, LagoonBuildState, LagoonEnvironment, LagoonService, LagoonSnapshot } from '../types'

// Reads Lagoon's GraphQL answer and the repo's .lagoon.yml into what the pane
// shows. Pure, so the tests read it.

export const QUERY = (project: string) => `{
  me { email }
  projectByName(name: "${project}") {
    name productionEnvironment standbyProductionEnvironment routerPattern
    environments {
      name environmentType deployType deployBaseRef deployHeadRef deployTitle route routes
      kubernetes { name routerPattern }
      deployments(limit: 1) { name status buildStep created started completed uiLink }
    }
  }
}`

type ApiDeployment = {
  name: string
  status: string
  buildStep?: string | null
  created?: string | null
  started?: string | null
  completed?: string | null
  uiLink?: string | null
}

type ApiEnvironment = {
  name: string
  environmentType: string
  deployType: string
  deployBaseRef?: string | null
  deployHeadRef?: string | null
  deployTitle?: string | null
  route?: string | null
  routes?: string | null
  kubernetes?: { name?: string | null; routerPattern?: string | null } | null
  deployments?: ApiDeployment[] | null
}

type ApiProject = {
  name: string
  productionEnvironment?: string | null
  standbyProductionEnvironment?: string | null
  routerPattern?: string | null
  environments: ApiEnvironment[]
}

// A Lagoon project name, as safe to splice into a query.
export function isProjectName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(name)
}

// `project: 'acme'` at the top level of .lagoon.yml.
export function projectOf(lagoonYml: string): string | undefined {
  const match = /^project:\s*['"]?([a-z0-9-]+)['"]?\s*$/m.exec(lagoonYml)
  return match?.[1]
}

const ACTIVE = new Set(['new', 'pending', 'queued', 'running'])

export function buildState(status: string): LagoonBuildState {
  const lower = status.toLowerCase()
  if (ACTIVE.has(lower)) return 'active'
  if (lower === 'complete') return 'complete'
  if (lower === 'cancelled') return 'cancelled'
  return 'failed'
}

// Lagoon answers UTC as "2026-10-12 11:35:43", with no zone.
export function lagoonTime(value: string | null | undefined): number | undefined {
  if (!value) return undefined
  const ms = Date.parse(`${value.replace(' ', 'T')}Z`)
  return Number.isNaN(ms) ? undefined : ms
}

export function environments(project: ApiProject, branch: string | undefined, lagoonYml: string | undefined): LagoonEnvironment[] {
  const production = new Set([project.productionEnvironment, project.standbyProductionEnvironment].filter(Boolean))
  const list = project.environments.map(env => {
    const isPull = env.deployType === 'pullrequest'
    const ref = isPull ? env.deployHeadRef : env.deployBaseRef
    return {
      name: env.name,
      type: env.environmentType,
      isProduction: production.has(env.name) || env.environmentType === 'production',
      isCurrent: branch !== undefined && (ref === branch || ref === `origin/${branch}` || env.name === slug(branch)),
      title: isPull && env.deployTitle ? env.deployTitle : undefined,
      cluster: env.kubernetes?.name || undefined,
      build: build(env.deployments?.[0]),
      services: services(env, lagoonYml, generatedSuffix(project, env)),
    }
  })
  return list.sort(byInterest)
}

function build(deployment: ApiDeployment | undefined): LagoonBuild | undefined {
  if (deployment === undefined) return undefined
  return {
    name: deployment.name,
    status: deployment.status.toLowerCase(),
    state: buildState(deployment.status),
    step: deployment.buildStep ?? undefined,
    createdAt: lagoonTime(deployment.created),
    startedAt: lagoonTime(deployment.started),
    completedAt: lagoonTime(deployment.completed),
    url: deployment.uiLink ?? undefined,
  }
}

// The domain Lagoon generates this environment's routes under
// (`<service>.<suffix>`), from the router pattern, else the cluster's name.
export function generatedSuffix(project: Pick<ApiProject, 'name' | 'routerPattern'>, env: Pick<ApiEnvironment, 'name' | 'kubernetes'>): string | undefined {
  const pattern = project.routerPattern || env.kubernetes?.routerPattern
  if (pattern) {
    return pattern
      .replace(/^\$\{service\}\./, '')
      .replaceAll('${environment}', env.name)
      .replaceAll('${project}', project.name)
  }
  return env.kubernetes?.name || undefined
}

// The routes worth a click: those .lagoon.yml names (the project's own),
// every route when it names none; a generated route only where no canonical
// one carries its name (auth.example.com over auth.<env>.<project>.<cluster>).
export function services(env: Pick<ApiEnvironment, 'route' | 'routes'>, lagoonYml: string | undefined, suffix?: string): LagoonService[] {
  const urls = [...new Set([env.route, ...(env.routes ?? '').split(',')].map(url => url?.trim()).filter((url): url is string => !!url))]
  const own = lagoonYml === undefined ? [] : urls.filter(url => names(lagoonYml, host(url)))
  const chosen = (own.length > 0 ? own : urls).map(url => ({ label: label(host(url)), url, isGenerated: isGenerated(host(url), suffix) }))
  const canonical = new Set(chosen.filter(one => !one.isGenerated).map(one => one.label))
  const primary = env.route?.trim()
  return chosen
    .filter(one => !one.isGenerated || !canonical.has(one.label))
    .map(({ label, url }) => ({ label, url, isPrimary: url === primary }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

function isGenerated(hostname: string, suffix: string | undefined): boolean {
  return suffix !== undefined && hostname.endsWith(`.${suffix}`)
}

// Whether the text names the host as a whole word (not inside a longer host).
function names(text: string, hostname: string): boolean {
  const escaped = hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\w.-])${escaped}($|[^\\w.-])`, 'm').test(text)
}

function host(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/[/:].*$/, '')
}

// cms.dev.example.com -> cms; www.example.com and example.com stay whole.
function label(hostname: string): string {
  const parts = hostname.split('.')
  return parts.length <= 2 || parts[0] === 'www' ? hostname : parts[0]!
}

// Lagoon's environment name for a branch: lowercase, non-alphanumerics as dashes.
function slug(branch: string): string {
  return branch.toLowerCase().replace(/[^a-z0-9-]/g, '-')
}

// The current branch's environment, then production, then the most recently built.
function byInterest(a: LagoonEnvironment, b: LagoonEnvironment): number {
  return Number(b.isCurrent) - Number(a.isCurrent)
    || Number(b.isProduction) - Number(a.isProduction)
    || (b.build?.createdAt ?? 0) - (a.build?.createdAt ?? 0)
}

// `lagoon ssh -e stage`, `--environment=pr-12`, `drush @lagoon.acme-production`;
// only a lagoon command (not a file named *.lagoon.yml), and only one that
// names this project or none.
export function targetOf(command: string, project: string): string | undefined {
  for (const segment of command.split(/;|&&|\|\||\|/)) {
    const words = segment.trim().replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)*/, '')
    if (/^lagoon\s/.test(words)) {
      const named = /\s(?:-p|--project)(?:=|\s+)['"]?([\w-]+)/.exec(words)?.[1]
      if (named !== undefined && named !== project) continue
      const flag = /\s(?:-e|--environment)(?:=|\s+)['"]?([\w.-]+)/.exec(words)
      if (flag) return flag[1]
    }
    const alias = new RegExp(`@lagoon\\.${project}-([\\w-]+)`).exec(words)
    if (alias) return alias[1]
  }
  return undefined
}

// `lagoon raw` prints the answer's JSON; anything around it (a notice, an
// update hint) is dropped. Throws when there is no JSON object.
export function parseRaw(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start === -1 || end < start) throw new Error(`unexpected lagoon output: ${firstLine(stdout) || '(empty)'}`)
  return JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>
}

export function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.slice(0, 200) ?? ''
}

// A failed read keeps the last good environments of the same project, never
// another project's.
export function failedRead(previous: LagoonSnapshot | null, project: string, error: string): LagoonSnapshot {
  return previous !== null && previous.project === project
    ? { ...previous, error }
    : { project, environments: [], fetchedAt: undefined, error }
}

// Builds are news only against a good read of the same project: the first
// read, or the first after failures, only sets the baseline.
export function isBaseline(previous: LagoonSnapshot | null, fresh: LagoonSnapshot): previous is LagoonSnapshot {
  return previous !== null
    && previous.project === fresh.project
    && previous.fetchedAt !== undefined
    && fresh.error === undefined
}

export function elapsed(from: number | undefined, to: number): string {
  if (from === undefined) return ''
  const seconds = Math.max(0, Math.round((to - from) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}m`
  return `${Math.floor(seconds / 86_400)}d`
}

// A CLI error that a login fixes: an expired or refused token, an SSH key
// Lagoon does not know.
export function isLoginError(error: string): boolean {
  return /token|unauthori[sz]ed|unauthenticated|\b40[13]\b|permission denied|publickey|ssh|login|expired/i.test(error)
}
