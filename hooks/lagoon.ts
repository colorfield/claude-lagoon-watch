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
    url: webUrl(deployment.uiLink),
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
  const urls = [...new Set([env.route, ...(env.routes ?? '').split(',')].map(webUrl).filter((url): url is string => url !== undefined))]
  const own = lagoonYml === undefined ? [] : urls.filter(url => names(lagoonYml, host(url)))
  const chosen = (own.length > 0 ? own : urls).map(url => ({ label: label(host(url)), url, isGenerated: isGenerated(host(url), suffix) }))
  const canonical = new Set(chosen.filter(one => !one.isGenerated).map(one => one.label))
  const primary = webUrl(env.route)
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

// The simple commands of a shell line, each as its words: quotes kept
// together, heredoc bodies dropped (they are data, not commands).
export function simpleCommands(line: string): string[][] {
  const text = line.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, '')
  const commands: string[][] = []
  let words: string[] = []
  let word: string | undefined
  let quote: string | undefined
  const endWord = () => {
    if (word !== undefined) words.push(word)
    word = undefined
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0) commands.push(words)
    words = []
  }
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else word = (word ?? '') + char
    } else if (char === "'" || char === '"') {
      quote = char
      word = word ?? ''
    } else if (char === '\\' && index + 1 < text.length) {
      index += 1
      if (text[index] !== '\n') word = (word ?? '') + text[index]
    } else if (/[;&|()\n]/.test(char)) {
      endCommand()
    } else if (/\s/.test(char)) {
      endWord()
    } else {
      word = (word ?? '') + char
    }
  }
  endCommand()
  return commands
}

// The command a wrapper runs: env assignments and `timeout 60`, `direnv exec .`,
// `devbox run --`, `nohup`, `sudo` and the like dropped.
function unwrapped(command: readonly string[]): string[] {
  let words = [...command]
  for (;;) {
    const [first = '', second = ''] = words
    if (/^[A-Z_][A-Z0-9_]*=/.test(first) || ['exec', 'time', 'command', 'env', 'nohup', 'sudo'].includes(first)) words = words.slice(1)
    else if (first === 'timeout') words = words.slice(words.findIndex((one, index) => index > 0 && /^\d/.test(one)) + 1 || 1)
    else if (first === 'direnv' && second === 'exec') words = words.slice(3)
    else if (first === 'devbox' && second === 'run') words = words.slice(words[2] === '--' ? 3 : 2)
    else return words
  }
}

// lagoon flags that take a value (the rest are switches).
const VALUED = new Set(['-p', '--project', '-e', '--environment', '-l', '--lagoon', '-C', '--command', '-i', '--ssh-key', '--config-file'])

export type LagoonCommand = { environment: string; summary: string }

// The Lagoon command a shell line runs against an environment of this
// project, told short: `lagoon ssh: drush cr`, `lagoon deploy latest`,
// `drush uli` (through an `@lagoon.<project>-<env>` alias).
// With `environments` (the project's, when known), an alias must name one
// exactly: `@lagoon.acme-intranet-production` is another project's.
export function lagoonCommand(line: string, project: string, environments?: readonly string[]): LagoonCommand | undefined {
  let found: LagoonCommand | undefined
  for (const command of simpleCommands(line)) {
    const words = unwrapped(command)
    const name = words[0]?.split('/').at(-1)

    if (name === 'lagoon') {
      const values = new Map<string, string>()
      const subcommands: string[] = []
      let remote: string[] = []
      for (let index = 1; index < words.length; index += 1) {
        const one = words[index]!
        if (one === '--') {
          remote = words.slice(index + 1)
          break
        }
        const [flag, inline] = one.split(/=(.*)/s)
        if (VALUED.has(flag!)) {
          values.set(flag!.replace(/^--?/, ''), inline ?? words[index + 1] ?? '')
          if (inline === undefined) index += 1
        } else if (!one.startsWith('-')) {
          subcommands.push(one)
        }
      }
      const named = values.get('p') ?? values.get('project')
      const environment = values.get('e') ?? values.get('environment')
      if (environment === undefined || (named !== undefined && named !== project)) continue
      const run = remote.length > 0 ? remote.join(' ') : values.get('C') ?? values.get('command')
      found = { environment, summary: `lagoon ${subcommands.join(' ')}${run ? `: ${run}` : ''}`.trim() }
    }

    const alias = words.findIndex(one => one.startsWith(`@lagoon.${project}-`))
    if (name === 'drush' && alias !== -1) {
      const environment = words[alias]!.slice(`@lagoon.${project}-`.length)
      const rest = words.filter((_, index) => index !== 0 && index !== alias)
      const isKnown = environments === undefined || environments.includes(environment)
      if (environment !== '' && isKnown) found = { environment, summary: `drush ${rest.join(' ')}`.trim() }
    }
  }
  return found
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

// A CLI error that a login fixes: a token refused or expired, an SSH key
// Lagoon does not accept. A network failure (even one ssh reports) is not.
export function isLoginError(error: string): boolean {
  return /token (?:is )?(?:expired|invalid)|expired token|invalid token|unauthori[sz]ed|unauthenticated|\b401\b|permission denied \(publickey|unable to authenticate|no supported methods remain|not logged in|please (?:re-?)?log ?in/i.test(error)
}

// The forms a git remote may be registered under in Lagoon, credentials
// always stripped (an https remote's user and token, an ssh:// remote's
// password; any spelling of the scheme): as written, and as the other of its
// SSH and https forms.
export function gitUrlCandidates(remote: string): string[] {
  const clean = remote.trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, scheme => scheme.toLowerCase())
    .replace(/^(https?:\/\/)[^@/]+@/, '$1')
    .replace(/^(ssh:\/\/[^:@/]+):[^@/]*@/, '$1@')
  if (!/^[\w@:/.+~-]+$/.test(clean)) return []
  const https = /^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/.exec(clean)
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?$/.exec(clean)
  const other = https ? `git@${https[1]}:${https[2]}.git` : ssh ? `https://${ssh[1]}/${ssh[2]}.git` : undefined
  return [...new Set([clean, other].filter((one): one is string => one !== undefined))]
}

// The repository a git URL names, as `host/path` in lowercase, whatever its
// form (scp-like SSH, ssh://, https): user, port and `.git` dropped, so two
// spellings of one repository compare equal.
export function repoKey(url: string | null | undefined): string | undefined {
  const clean = url?.trim().toLowerCase() ?? ''
  const full = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(clean)
  const scp = /^(?:[^@/:]+@)?([^:/]+):(?!\/)(.+?)(?:\.git)?\/?$/.exec(clean)
  const match = full ?? scp
  return match ? `${match[1]}/${match[2]}` : undefined
}

export function isSameRepo(a: string | null | undefined, b: string | null | undefined): boolean {
  const key = repoKey(a)
  return key !== undefined && key === repoKey(b)
}

// A name as Lagoon would spell it (`Acme_Site` -> `acme-site`), or undefined.
export function asProjectName(raw: string): string | undefined {
  const name = raw.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return isProjectName(name) ? name : undefined
}

export type ProjectHint = { name: string; source: string }

// The project names the repo's own files suggest, most telling first. Each is
// a guess until Lagoon confirms it: a compose file's LAGOON_PROJECT is often
// the local project's name, not the Lagoon one.
// - a Drush site alias: `user: acme-${env-name}`
// - LAGOON_PROJECT in a compose or env file (`${VAR:-acme}` gives its default)
// - the repository's own name, from the git remote
export function projectHints(files: readonly { path: string; text: string }[], remote: string | null | undefined): ProjectHint[] {
  const hints: ProjectHint[] = []
  const add = (raw: string | undefined, source: string) => {
    const name = raw === undefined ? undefined : asProjectName(raw)
    if (name !== undefined && !hints.some(hint => hint.name === name)) hints.push({ name, source })
  }
  for (const file of files.filter(one => one.path.endsWith('.site.yml'))) {
    for (const match of file.text.matchAll(/^\s*user:\s*['"]?([A-Za-z0-9_-]+)-\$\{env-name\}/gm)) add(match[1], 'Drush alias')
  }
  for (const file of files.filter(one => !one.path.endsWith('.site.yml'))) {
    for (const match of file.text.matchAll(/^[\s-]*LAGOON_PROJECT\s*[:=]\s*(?:&\S+\s+)?['"]?([^'"\s#]+)/gm)) {
      const value = match[1]!
      add(value.startsWith('$') ? /^\$\{\w+:?-([^}]+)\}$/.exec(value)?.[1] : value, 'LAGOON_PROJECT')
    }
  }
  add(repoKey(remote)?.split('/').at(-1), 'repository name')
  return hints
}

// A link from an answer we do not control (the Lagoon API, a status page) is
// drawn clickable only when it is a web address: never file:, javascript: or
// an app's own scheme.
export function webUrl(url: string | null | undefined): string | undefined {
  const trimmed = url?.trim()
  return trimmed && /^https?:\/\/[^\s/]/i.test(trimmed) ? trimmed : undefined
}
