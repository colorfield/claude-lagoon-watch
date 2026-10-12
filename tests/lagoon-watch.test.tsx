import { describe, expect, test } from 'claude-code/testing'

import { buildState, environments, generatedSuffix, lagoonTime, projectOf, services, targetOf } from '../hooks/lagoon'
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
  })
})

const SNAPSHOT: LagoonSnapshot = {
  project: 'acme',
  environments: environments(PROJECT, 'stage', YML),
  fetchedAt: Date.parse('2026-10-12T11:40:00Z'),
  error: undefined,
}

describe('pane', () => {
  test('draws each environment with its build and services', async ($, on) => {
    on('state.get', ($, e) => ({ value: { value: e.key === 'snapshot' ? SNAPSHOT : null, version: 1 } }) as never)
    on('clock.now', () => ({ value: SNAPSHOT.fetchedAt }))
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'lagoon-watch', surface, component: 'Pane', requestId: 'lagoon-watch', props: {} as never, viewport: { columns: 100, rows: 40 } as never })
      expect(await ui.find({ type: 'Link', text: 'build log' })).toBeDefined()
      expect(await ui.find({ type: 'Link', text: 'dashboard' })).toBeDefined()
      expect(await ui.find({ text: /● running · applyingDeployments · 4m09s/ })).toBeDefined()
      expect(await ui.find({ type: 'Link', text: 'search' })).toBeDefined()
      await ui.unmount()
    }
  })
})
