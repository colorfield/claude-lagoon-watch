import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { buildState, environments, failedRead, generatedSuffix, isBaseline, lagoonTime, parseRaw, projectOf, services, targetOf } from '../hooks/lagoon'
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
          - auth.production.acme.cluster.example.net
          - auth-admin.production.acme.cluster.example.net
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
      routes: 'https://nginx.dev.acme.cluster.example.net,https://build.dev.acme.cluster.example.net',
      deployments: [{ name: 'lagoon-build-aaaaa', status: 'complete', buildStep: 'finalizingBuild', created: '2026-09-25 11:01:46', started: '2026-09-25 11:01:54', completed: '2026-09-25 11:18:20', uiLink: 'https://dashboard.example/projects/acme/acme-dev/deployments/lagoon-build-aaaaa' }],
    },
    {
      name: 'production', environmentType: 'production', deployType: 'branch', deployBaseRef: 'production', route: 'https://cms.acme.com',
      routes: 'https://cms.acme.com,https://build.acme.com,https://auth.acme.com,https://auth.production.acme.cluster.example.net,https://auth-admin.production.acme.cluster.example.net,https://auth-admin.acme.com',
      kubernetes: { name: 'cluster.example.net', routerPattern: '${environment}.${project}.cluster.example.net' },
      deployments: [{ name: 'lagoon-build-bbbbb', status: 'complete', created: '2026-10-08 16:29:54', started: '2026-10-08 16:30:02', completed: '2026-10-08 16:53:22', uiLink: 'https://dashboard.example/projects/acme/acme-production/deployments/lagoon-build-bbbbb' }],
    },
    {
      name: 'stage', environmentType: 'development', deployType: 'branch', deployBaseRef: 'stage', route: 'https://cms.stage.acme.com',
      routes: 'https://nginx.stage.acme.cluster.example.net,https://cms.stage.acme.com,https://search.stage.acme.com',
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
    expect(services(stage, YML)).toEqual([
      { label: 'cms', url: 'https://cms.stage.acme.com' },
      { label: 'search', url: 'https://search.stage.acme.com' },
    ])
    // dev's domain is not in this .lagoon.yml: every route is shown.
    expect(services(PROJECT.environments[0]!, YML).map(one => one.label)).toEqual(['build', 'cms', 'nginx'])
  })

  test('prefers a canonical route over the generated one of the same name', () => {
    const production = PROJECT.environments[1]!
    const suffix = generatedSuffix(PROJECT, production)
    expect(suffix).toBe('production.acme.cluster.example.net')
    expect(services(production, YML, suffix)).toEqual([
      { label: 'auth', url: 'https://auth.acme.com' },
      { label: 'auth-admin', url: 'https://auth-admin.acme.com' },
      { label: 'build', url: 'https://build.acme.com' },
      { label: 'cms', url: 'https://cms.acme.com' },
    ])
    // A generated route with no canonical twin stays.
    expect(services({ route: null, routes: 'https://nginx.dev.acme.cluster.example.net,https://cms.dev.acme.com' }, undefined, 'dev.acme.cluster.example.net'))
      .toEqual([{ label: 'cms', url: 'https://cms.dev.acme.com' }, { label: 'nginx', url: 'https://nginx.dev.acme.cluster.example.net' }])
  })

  test('reads statuses and UTC times', () => {
    expect(buildState('RUNNING')).toBe('active')
    expect(buildState('queued')).toBe('active')
    expect(buildState('error')).toBe('failed')
    expect(lagoonTime('2026-10-12 11:35:43')).toBe(Date.parse('2026-10-12T11:35:43Z'))
  })

  test('finds the environment a command targets', () => {
    expect(targetOf('lagoon ssh -p acme -e production -- drush cr', 'acme')).toBe('production')
    expect(targetOf('lagoon list deployments --environment=stage', 'acme')).toBe('stage')
    expect(targetOf('drush @lagoon.acme-stage uli', 'acme')).toBe('stage')
    expect(targetOf('ls -e foo', 'acme')).toBeUndefined()
    // A compose file named after Lagoon, or another project's environment, is no target.
    expect(targetOf('docker compose -f docker-compose.lagoon.yml exec -e VAR=1 cli bash', 'acme')).toBeUndefined()
    expect(targetOf('lagoon ssh -p globex -e production', 'acme')).toBeUndefined()
    expect(targetOf('lagoon ssh -p acme -e production', 'acme')).toBe('production')
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

const SNAPSHOT: LagoonSnapshot = {
  project: 'acme',
  environments: environments(PROJECT, 'stage', YML),
  fetchedAt: Date.parse('2026-10-12T11:40:00Z'),
  error: undefined,
}

const PANE = { plugin: 'lagoon-watch', component: 'Pane', requestId: 'lagoon-watch', props: {} as never } as const
const run = (stdout: string, exitCode = 0, stderr = '') =>
  ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })

// A repo at /repo whose .lagoon.yml names no project; `answer` plays the lagoon CLI.
function machine(on: On, answer: (query: string) => ReturnType<typeof run> | 'missing') {
  const seen = { toasts: 0, status: [] as (string | undefined)[] }
  on('session.root', () => ({ value: '/repo' }))
  on('session.repo', () => ({ value: { root: '/repo', remote: 'git@github.com:o/acme.git', internal: false, name: null } }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: YML.replace("project: 'acme'\n", '') }))
  on('clock.now', () => ({ value: SNAPSHOT.fetchedAt! }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', () => { seen.toasts += 1; return { value: undefined } })
  on('ui.status', ($, e) => { seen.status.push(e.text); return { value: undefined } })
  on('process.run', ($, e) => {
    if (e.argv[0] === 'git') return run('stage\n')
    const result = answer(e.argv.at(-1) ?? '')
    if (result === 'missing') throw new Error('spawn lagoon ENOENT')
    return result
  })
  return seen
}

const FOUND = JSON.stringify({ projectByGitUrl: { name: 'acme' } })
const READ = JSON.stringify({ projectByName: PROJECT })

describe('pane', () => {
  test('draws each environment with its build and services', async ($, on) => {
    machine(on, query => run(query.includes('projectByGitUrl') ? FOUND : READ))
    await $.command.run({ command: 'lagoon', args: '' } as never)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Link', text: 'build log' })).toBeDefined()
      expect(await ui.find({ type: 'Link', text: 'dashboard' })).toBeDefined()
      expect(await ui.find({ text: /● running · applyingDeployments · 4m09s/ })).toBeDefined()
      expect(await ui.find({ type: 'Link', text: 'search' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'refresh' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a failed lookup shows why, and Refresh recovers once the CLI works', async ($, on) => {
    let isLoggedIn = false
    machine(on, query => !isLoggedIn ? run('', 1, 'Error: token expired') : run(query.includes('projectByGitUrl') ? FOUND : READ))
    await $.command.run({ command: 'lagoon', args: '' } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ text: /Could not find the Lagoon project: Error: token expired/ })).toBeDefined()

    isLoggedIn = true
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Link', text: 'build log' })).toBeDefined()
    await ui.unmount()
  })

  test('a missing lagoon binary is said, not read forever', async ($, on) => {
    machine(on, () => 'missing')
    await $.command.run({ command: 'lagoon', args: '' } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
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
    await $.command.run({ command: 'lagoon', args: '' } as never)
    await $.command.run({ command: 'lagoon', args: '' } as never)
    await $.command.run({ command: 'lagoon', args: '' } as never)
    expect(reads).toBe(3)
    expect(seen.toasts).toBe(0)
    expect(seen.status.at(-1)).toMatch(/^Lagoon ● stage applyingDeployments/)
  })
})
