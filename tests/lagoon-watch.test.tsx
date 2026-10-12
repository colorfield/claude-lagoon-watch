import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { buildState, environments, failedRead, generatedSuffix, isBaseline, gitUrlCandidates, isLoginError, lagoonCommand, lagoonTime, parseRaw, projectOf, services, simpleCommands, webUrl } from '../hooks/lagoon'
import { clusterComponent, platform, windowText, zoneOf } from '../hooks/status'
import type { LagoonSnapshot } from '../types'

const YML = `docker-compose-yaml: docker-compose.yml
project: 'acme'
environments:
  production:
    routes:
      - nginx:
          - cms.acme.com
      - build:
          - build.acme.com
      - auth:
          - auth.acme.com
          - auth.production.acme.ch1.example.net
          - auth-admin.production.acme.ch1.example.net
          - auth-admin.acme.com
  stage:
    routes:
      - nginx:
          - cms.stage.acme.com
      - solr:
          - search.stage.acme.com
`

const PROJECT = {
  name: 'acme',
  productionEnvironment: 'production',
  environments: [
    {
      name: 'dev', environmentType: 'development', deployType: 'branch', deployBaseRef: 'dev', route: 'https://cms.dev.acme.com',
      routes: 'https://nginx.dev.acme.ch1.example.net,https://build.dev.acme.ch1.example.net',
      deployments: [{ name: 'lagoon-build-aaaaa', status: 'complete', buildStep: 'finalizingBuild', created: '2026-09-25 11:01:46', started: '2026-09-25 11:01:54', completed: '2026-09-25 11:18:20', uiLink: 'https://dashboard.example/projects/acme/acme-dev/deployments/lagoon-build-aaaaa' }],
    },
    {
      name: 'production', environmentType: 'production', deployType: 'branch', deployBaseRef: 'production', route: 'https://cms.acme.com',
      routes: 'https://cms.acme.com,https://build.acme.com,https://auth.acme.com,https://auth.production.acme.ch1.example.net,https://auth-admin.production.acme.ch1.example.net,https://auth-admin.acme.com',
      kubernetes: { name: 'ch1.example.net', routerPattern: '${environment}.${project}.ch1.example.net' },
      deployments: [{ name: 'lagoon-build-bbbbb', status: 'complete', created: '2026-10-08 16:29:54', started: '2026-10-08 16:30:02', completed: '2026-10-08 16:53:22', uiLink: 'https://dashboard.example/projects/acme/acme-production/deployments/lagoon-build-bbbbb' }],
    },
    {
      name: 'stage', environmentType: 'development', deployType: 'branch', deployBaseRef: 'stage', route: 'https://cms.stage.acme.com',
      routes: 'https://nginx.stage.acme.ch1.example.net,https://cms.stage.acme.com,https://search.stage.acme.com',
      deployments: [{ name: 'lagoon-build-ccccc', status: 'running', buildStep: 'applyingDeployments', created: '2026-10-12 11:35:43', started: '2026-10-12 11:35:51', completed: null, uiLink: 'https://dashboard.example/projects/acme/acme-stage/deployments/lagoon-build-ccccc' }],
    },
    {
      name: 'pr-12', environmentType: 'development', deployType: 'pullrequest', deployHeadRef: 'feature/menu', deployTitle: 'New menu',
      route: null, routes: '', deployments: [],
    },
  ],
}

describe('lagoon', () => {
  test('reads the project name from .lagoon.yml', () => {
    expect(projectOf(YML)).toBe('acme')
    expect(projectOf('environments: {}')).toBeUndefined()
  })

  test('orders the branch environment first, then production, then the latest built', () => {
    const list = environments(PROJECT, 'stage', YML)
    expect(list.map(env => env.name)).toEqual(['stage', 'production', 'dev', 'pr-12'])
    expect(list[0]?.isCurrent).toBe(true)
    expect(list[0]?.build?.state).toBe('active')
    expect(list[1]?.isProduction).toBe(true)
  })

  test('matches a pull request environment by its head branch', () => {
    const list = environments(PROJECT, 'feature/menu', YML)
    expect(list[0]?.name).toBe('pr-12')
    expect(list[0]?.title).toBe('New menu')
  })

  test("links the project's own domains, the generated ones only when it names none", () => {
    const stage = PROJECT.environments[2]!
    expect(services(stage, YML).map(({ label, url }) => ({ label, url }))).toEqual([
      { label: 'cms', url: 'https://cms.stage.acme.com' },
      { label: 'search', url: 'https://search.stage.acme.com' },
    ])
    // dev's domain is not in this .lagoon.yml: every route is shown.
    expect(services(PROJECT.environments[0]!, YML).map(one => one.label)).toEqual(['build', 'cms', 'nginx'])
  })

  test('prefers a canonical route over the generated one of the same name', () => {
    const production = PROJECT.environments[1]!
    const suffix = generatedSuffix(PROJECT, production)
    expect(suffix).toBe('production.acme.ch1.example.net')
    expect(services(production, YML, suffix).map(({ label, url }) => ({ label, url }))).toEqual([
      { label: 'auth', url: 'https://auth.acme.com' },
      { label: 'auth-admin', url: 'https://auth-admin.acme.com' },
      { label: 'build', url: 'https://build.acme.com' },
      { label: 'cms', url: 'https://cms.acme.com' },
    ])
    // A generated route with no canonical twin stays.
    expect(services({ route: null, routes: 'https://nginx.dev.acme.ch1.example.net,https://cms.dev.acme.com' }, undefined, 'dev.acme.ch1.example.net').map(one => one.label))
      .toEqual(['cms', 'nginx'])
    expect(services(production, YML, suffix).find(one => one.isPrimary)?.url).toBe('https://cms.acme.com')
  })

  test('reads statuses and UTC times', () => {
    expect(buildState('RUNNING')).toBe('active')
    expect(buildState('queued')).toBe('active')
    expect(buildState('error')).toBe('failed')
    expect(lagoonTime('2026-10-12 11:35:43')).toBe(Date.parse('2026-10-12T11:35:43Z'))
  })

  test('tells the Lagoon command a shell line runs, short', () => {
    const on = (line: string) => lagoonCommand(line, 'acme')
    expect(on('lagoon ssh -p acme -e production -- drush cr')).toEqual({ environment: 'production', summary: 'lagoon ssh: drush cr' })
    expect(on("cd web && lagoon ssh -e stage -C 'drush uli --name=admin'")).toEqual({ environment: 'stage', summary: 'lagoon ssh: drush uli --name=admin' })
    expect(on('lagoon deploy latest --environment=pr-12 --force')).toEqual({ environment: 'pr-12', summary: 'lagoon deploy latest' })
    expect(on('timeout 60 drush @lagoon.acme-stage uli')).toEqual({ environment: 'stage', summary: 'drush uli' })
    expect(on('direnv exec . devbox run -- lagoon ssh -e dev -- drush status')).toEqual({ environment: 'dev', summary: 'lagoon ssh: drush status' })
    expect(on('drush @lagoon.acme-stage uli')).toEqual({ environment: 'stage', summary: 'drush uli' })
    // Another project whose name starts like this one's.
    expect(lagoonCommand('drush @lagoon.acme-intranet-production cr', 'acme', ['dev', 'production'])).toBeUndefined()
    expect(lagoonCommand('drush @lagoon.acme-production cr', 'acme', ['dev', 'production'])).toEqual({ environment: 'production', summary: 'drush cr' })
    expect(on('/opt/homebrew/bin/lagoon list deployments -p acme -e dev')).toEqual({ environment: 'dev', summary: 'lagoon list deployments' })
  })

  test('ignores what only looks like one', () => {
    const on = (line: string) => lagoonCommand(line, 'acme')
    // Another project, no environment, a compose file, a commit message, a script's data.
    expect(on('lagoon ssh -p globex -e production')).toBeUndefined()
    expect(on('lagoon list projects')).toBeUndefined()
    expect(on('docker compose -f docker-compose.lagoon.yml exec -e VAR=1 cli bash')).toBeUndefined()
    expect(on('git commit -m "lagoon ssh -e production -- drush cr"')).toBeUndefined()
    expect(on("R=~/x; python3 - <<'EOF'\nimport os\ns = 'x'; lagoon ssh -p acme -e production -- drush cr\nEOF\necho done")).toBeUndefined()
    expect(on('ls -e foo')).toBeUndefined()
  })

  test('splits a shell line into its simple commands', () => {
    expect(simpleCommands(`A=1 lagoon ssh -e 'my env' && echo "a;b" | wc -l`)).toEqual([
      ['A=1', 'lagoon', 'ssh', '-e', 'my env'],
      ['echo', 'a;b'],
      ['wc', '-l'],
    ])
  })

  test('reads the JSON out of noisy CLI output', () => {
    expect(parseRaw('A new version is available\n{"a":1}\n')).toEqual({ a: 1 })
    expect(() => parseRaw('Error: token expired')).toThrow(/unexpected lagoon output/)
  })

  test("never keeps another project's environments after a failed read", () => {
    const acme = { project: 'acme', environments: environments(PROJECT, 'stage', YML), fetchedAt: 1, error: undefined }
    expect(failedRead(acme, 'acme', 'boom').environments.length).toBe(4)
    expect(failedRead(acme, 'globex', 'boom')).toEqual({ project: 'globex', environments: [], fetchedAt: undefined, error: 'boom' })
  })

  test('only a good read of the same project is a baseline', () => {
    const good = { project: 'acme', environments: [], fetchedAt: 1, error: undefined }
    expect(isBaseline(null, good)).toBe(false)
    expect(isBaseline({ ...good, fetchedAt: undefined, error: 'boom' }, good)).toBe(false)
    expect(isBaseline({ ...good, project: 'globex' }, good)).toBe(false)
    expect(isBaseline(good, good)).toBe(true)
  })
})

const SUMMARY = JSON.stringify({
  page: { name: 'Example Hosting', url: 'https://status.example.com' },
  status: { indicator: 'none', description: 'All Systems Operational' },
  components: [
    { id: 'g0', name: 'General', status: 'operational', group: true },
    { id: 'g1', name: 'Switzerland', status: 'operational', group: true },
    { id: 'g2', name: 'Germany', status: 'operational', group: true },
    { id: 'c0', name: 'Lagoon API', status: 'operational', group_id: 'g0' },
    { id: 'c1', name: 'ch1.lagoon', status: 'operational', group_id: 'g1' },
    { id: 'c2', name: 'de1.lagoon', status: 'degraded_performance', group_id: 'g2' },
  ],
  incidents: [
    { name: 'Slow builds', impact: 'minor', status: 'investigating', shortlink: 'https://stspg.example/1' },
    { name: 'Old outage', impact: 'major', status: 'resolved' },
  ],
  scheduled_maintenances: [
    { name: 'Maintenance EMEA', status: 'scheduled', scheduled_for: '2026-10-14T21:00:00Z', scheduled_until: '2026-10-15T02:00:00Z', components: [{ id: 'c1', name: 'ch1.lagoon' }] },
    { name: 'Maintenance EMEA', status: 'scheduled', scheduled_for: '2026-10-13T21:00:00Z', scheduled_until: '2026-10-14T02:00:00Z', shortlink: 'https://stspg.example/2', components: [{ id: 'c0', name: 'Lagoon API' }, { id: 'c1', name: 'ch1.lagoon' }] },
  ],
})

describe('status page', () => {
  test("reads the overall status, open incidents, the project's cluster and each region's next window", () => {
    const read = platform(SUMMARY, 'ch1.example.net', Date.parse('2026-10-12T12:00:00Z'))
    expect(read.description).toBe('All Systems Operational')
    expect(read.incidents.map(one => one.name)).toEqual(['Slow builds'])
    expect(read.cluster).toMatchObject({ name: 'ch1.lagoon', region: 'Switzerland', status: 'operational' })
    expect(read.cluster?.next?.from).toBe(Date.parse('2026-10-13T21:00:00Z'))
    expect(read.regions.map(one => [one.name, one.next?.url])).toEqual([
      ['General', 'https://stspg.example/2'],
      ['Switzerland', 'https://stspg.example/2'],
      ['Germany', undefined],
    ])
  })

  test("tells a window in the person's zone, and one that runs", () => {
    const window = { name: 'm', url: undefined, from: Date.parse('2026-10-13T21:00:00Z'), until: Date.parse('2026-10-14T02:00:00Z'), isInProgress: false }
    expect(windowText(window, 'Europe/Zurich')).toBe('Tue 13 Oct 23:00–04:00')
    expect(windowText({ ...window, isInProgress: true }, 'Europe/Zurich')).toBe('in progress until 04:00')
    expect(zoneOf('/var/db/timezone/zoneinfo/Europe/Zurich')).toBe('Europe/Zurich')
    expect(clusterComponent([{ name: 'de1.lagoon' }, { name: 'ch1.lagoon' }], 'ch1.example.net')?.name).toBe('ch1.lagoon')
  })

  test('knows a login problem when it reads one', () => {
    expect(isLoginError('Error: token expired')).toBe(true)
    expect(isLoginError('ssh: handshake failed: ssh: unable to authenticate, attempted methods [none publickey]')).toBe(true)
    expect(isLoginError('Permission denied (publickey).')).toBe(true)
    expect(isLoginError('Error: 504 Gateway Timeout')).toBe(false)
    // An outage ssh reports is no login problem.
    expect(isLoginError('ssh: connect to host ssh.lagoon.example port 32222: Operation timed out')).toBe(false)
  })

  test('never sends a remote with its credentials, and tries its other form', () => {
    expect(gitUrlCandidates('https://x-access-token:ghp_secret@github.com/o/acme.git'))
      .toEqual(['https://github.com/o/acme.git', 'git@github.com:o/acme.git'])
    expect(gitUrlCandidates('git@github.com:o/acme.git')).toEqual(['git@github.com:o/acme.git', 'https://github.com/o/acme.git'])
    expect(gitUrlCandidates('git@github.com:o/acme.git" } evil { "')).toEqual([])
    // Any spelling of the scheme, and an ssh:// password, are stripped too.
    expect(gitUrlCandidates('HTTPS://bot:ghp_secret@github.com/o/acme.git')[0]).toBe('https://github.com/o/acme.git')
    expect(gitUrlCandidates('ssh://git:hunter2@github.com/o/acme.git')).toEqual(['ssh://git@github.com/o/acme.git', 'https://github.com/o/acme.git'])
  })

  test('links only web addresses from answers it does not control', () => {
    expect(webUrl('https://dashboard.example/x')).toBe('https://dashboard.example/x')
    expect(webUrl('javascript:alert(1)')).toBeUndefined()
    expect(webUrl('file:///etc/passwd')).toBeUndefined()
    expect(webUrl('vscode://open?x')).toBeUndefined()
    expect(webUrl(null)).toBeUndefined()
    const env = { route: 'file:///etc/passwd', routes: 'https://cms.acme.com,javascript:alert(1)' }
    expect(services(env, undefined).map(one => one.url)).toEqual(['https://cms.acme.com'])
    const hostile = JSON.parse(SUMMARY) as { page: { url: string }; incidents: { shortlink?: string }[] }
    hostile.page.url = 'javascript:alert(1)'
    hostile.incidents[0]!.shortlink = 'file:///etc/passwd'
    const read = platform(JSON.stringify(hostile), undefined, 0)
    expect(read.url).toBe('')
    expect(read.incidents[0]?.url).toBeUndefined()
  })
})

const SNAPSHOT: LagoonSnapshot = {
  project: 'acme',
  environments: environments(PROJECT, 'stage', YML),
  fetchedAt: Date.parse('2026-10-12T11:40:00Z'),
  error: undefined,
}

const PANE = { plugin: 'lagoon-watch', component: 'Pane', requestId: 'lagoon-watch', props: {} as never } as const
const run = (stdout: string, exitCode = 0, stderr = '') =>
  ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })

// The machine the mod runs on: a repo at `world.root`, whose .lagoon.yml
// names no project unless `world.project` is set; `answer` plays the lagoon CLI.
type World = { root: string; project?: string; hasYml: boolean; remote: string | null; isHanging: boolean }

function machine(on: On, answer: (query: string) => ReturnType<typeof run> | 'missing', world: World = { root: '/repo', hasYml: true, remote: 'git@github.com:o/acme.git', isHanging: false }) {
  const seen = { toasts: 0, status: [] as (string | undefined)[], queries: [] as string[] }
  on('session.root', () => ({ value: world.root }))
  on('session.repo', () => ({ value: world.remote === null ? null : { root: world.root, remote: world.remote, internal: false, name: null } }) as never)
  on('fs.exists', () => ({ value: world.hasYml }))
  on('fs.read', () => ({ value: world.project === undefined ? YML.replace("project: 'acme'\n", '') : YML.replace("project: 'acme'", `project: '${world.project}'`) }))
  on('clock.now', () => ({ value: SNAPSHOT.fetchedAt! }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.panes', () => ({ value: [] }) as never)
  on('ui.toast', () => { seen.toasts += 1; return { value: undefined } })
  on('ui.status', ($, e) => { seen.status.push(e.text); return { value: undefined } })
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: SUMMARY } }) as never)
  on('fs.stat', () => ({ value: { realPath: '/usr/share/zoneinfo/Europe/Zurich' } }) as never)
  on('process.run', ($, e) => {
    if (e.argv[0] === 'git') return run('stage\n')
    if (e.argv[1] === 'config') return run('example\n')
    if (world.isHanging) return new Promise<never>(() => {})
    const query = e.argv.at(-1) ?? ''
    seen.queries.push(query)
    const result = answer(query)
    if (result === 'missing') throw new Error('spawn lagoon ENOENT')
    return result
  })
  return seen
}

const FOUND = JSON.stringify({ projectByGitUrl: { name: 'acme' } })
const READ = JSON.stringify({ me: { email: 'dev@example.com' }, projectByName: PROJECT })
const lagoonCli = (query: string) => run(query.includes('projectByGitUrl') ? FOUND : READ)

// /lagoon, then a Refresh press, which settles once the read is done.
async function openPane($: Engine, surface: 'terminal' | 'desktop' = 'terminal') {
  await $.command.run({ command: 'lagoon', args: '' } as never)
  const ui = await $.ui.mount({ ...PANE, surface })
  await ui.press({ key: 'refresh' })
  return ui
}

describe('pane', () => {
  test('draws each environment with its build and services', async ($, on) => {
    machine(on, lagoonCli)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await openPane($, surface)
      expect(await ui.find({ type: 'Link', text: 'build log' })).toBeDefined()
      expect(await ui.find({ type: 'Link', text: 'dashboard' })).toBeDefined()
      expect(await ui.find({ text: /● applyingDeployments · 4m09s/ })).toBeDefined()
      expect(await ui.find({ type: 'Link', text: 'search' })).toBeDefined()
      expect(await ui.find({ text: /dev@example\.com · example/ })).toBeDefined()
      expect(await ui.find({ type: 'Link', text: 'Example Hosting' })).toBeDefined()
      expect(await ui.find({ text: /ch1\.lagoon \(this project\): maintenance/ })).toBeDefined()
      expect(await ui.find({ text: /Germany/ })).toBeUndefined()
      await ui.press({ key: 'regions' })
      expect(await ui.find({ text: /Germany\s+none planned/ })).toBeDefined()
      await ui.press({ key: 'regions' })
      await ui.unmount()
    }
  })

  test('a failed lookup shows why, and Refresh recovers once the CLI works', async ($, on) => {
    let isLoggedIn = false
    machine(on, query => !isLoggedIn ? run('', 1, 'Error: token expired') : lagoonCli(query))
    const ui = await openPane($)
    expect(await ui.find({ text: /Could not find the Lagoon project: Error: token expired/ })).toBeDefined()
    expect(await ui.find({ text: /Not logged in to Lagoon \(example\)/ })).toBeDefined()
    expect(await ui.find({ text: /lagoon login/ })).toBeDefined()

    isLoggedIn = true
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Link', text: 'build log' })).toBeDefined()
    expect(await ui.find({ text: /Not logged in/ })).toBeUndefined()
    await ui.unmount()
  })

  test('an outage is shown as such, not as a login problem', async ($, on) => {
    machine(on, query => query.includes('projectByGitUrl') ? run(FOUND) : run('', 1, 'ssh: connect to host ssh.lagoon.example port 32222: Operation timed out'))
    const ui = await openPane($)
    expect(await ui.find({ text: /lagoon: ssh: connect to host/ })).toBeDefined()
    expect(await ui.find({ text: /Not logged in/ })).toBeUndefined()
    await ui.unmount()
  })

  test('only sends the remote without its credentials', async ($, on) => {
    const seen = machine(on, lagoonCli, { root: '/repo', hasYml: false, remote: 'https://bot:ghp_secret@github.com/o/acme.git', isHanging: false })
    const ui = await openPane($)
    expect(seen.queries.some(query => query.includes('ghp_secret'))).toBe(false)
    expect(seen.queries[0]).toContain('"https://github.com/o/acme.git"')
    await ui.unmount()
  })

  test("shows the command Claude last ran on an environment, and how it went", async ($, on) => {
    machine(on, lagoonCli)
    let isFailing = true
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: 'ok', isError: isFailing }) as never)
    const ui = await openPane($)
    await $.tool.call({ tool: 'Bash', command: 'lagoon ssh -p acme -e production -- drush cr' })
    expect(await ui.find({ text: /◆ Claude → production · 0s ago · ✗ failed/ })).toBeDefined()
    expect(await ui.find({ text: 'lagoon ssh: drush cr' })).toBeDefined()

    isFailing = false
    await $.tool.call({ tool: 'Bash', command: 'lagoon ssh -p acme -e stage -- drush uli' })
    expect(await ui.find({ text: /◆ Claude → stage · 0s ago · ✓/ })).toBeDefined()
    expect(await ui.find({ text: 'lagoon ssh: drush uli' })).toBeDefined()
    await ui.unmount()
  })

  test("after a /cd to another Lagoon project, Claude's last command there is not shown", async ($, on) => {
    const world: World = { root: '/repo', project: 'acme', hasYml: true, remote: null, isHanging: false }
    machine(on, lagoonCli, world)
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: 'ok' }) as never)
    const ui = await openPane($)
    await $.tool.call({ tool: 'Bash', command: 'lagoon ssh -e production -- drush cr' })
    expect(await ui.find({ text: /◆ Claude → production/ })).toBeDefined()

    Object.assign(world, { root: '/globex', project: 'globex' })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ text: /globex/ })).toBeDefined()
    expect(await ui.find({ text: /◆ Claude →/ })).toBeUndefined()
    await ui.unmount()
  })

  test("after a /cd to a repo with no Lagoon project, no cluster is called this project's", async ($, on) => {
    const world: World = { root: '/repo', project: 'acme', hasYml: true, remote: null, isHanging: false }
    machine(on, lagoonCli, world)
    const ui = await openPane($)
    expect(await ui.find({ text: /\(this project\)/ })).toBeDefined()

    Object.assign(world, { root: '/plain', project: undefined, hasYml: false })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ text: /No \.lagoon\.yml here/ })).toBeDefined()
    expect(await ui.find({ text: /\(this project\)/ })).toBeUndefined()
    await ui.unmount()
  })

  test("Claude's Bash result does not wait on a slow lagoon CLI", async ($, on) => {
    machine(on, lagoonCli, { root: '/repo', project: 'acme', hasYml: true, remote: null, isHanging: true })
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: 'pushed' }) as never)
    const answer = await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
    expect(answer.text).toBe('pushed')
  })

  test('/lagoon opens its pane without waiting on a slow lagoon CLI', async ($, on) => {
    machine(on, lagoonCli, { root: '/repo', project: 'acme', hasYml: true, remote: null, isHanging: true })
    expect((await $.command.run({ command: 'lagoon', args: '' } as never)).text).toBe('Lagoon pane opened.')
  })

  test('a missing lagoon binary is said, not read forever', async ($, on) => {
    machine(on, () => 'missing')
    const ui = await openPane($)
    expect(await ui.find({ text: /lagoon CLI unavailable/ })).toBeDefined()
    await ui.unmount()
  })

  test('the first good read after a failed one announces nothing', async ($, on) => {
    let reads = 0
    const seen = machine(on, query => {
      if (query.includes('projectByGitUrl')) return run(FOUND)
      reads += 1
      return reads === 1 ? run('', 1, 'Error: 504') : run(READ)
    })
    const ui = await openPane($)
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'refresh' })
    expect(reads).toBeGreaterThanOrEqual(3)
    expect(seen.toasts).toBe(0)
    expect(seen.status.at(-1)).toMatch(/^Lagoon ● stage applyingDeployments/)
    await ui.unmount()
  })
})
