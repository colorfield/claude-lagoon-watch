export type LagoonBuildState = 'active' | 'complete' | 'failed' | 'cancelled'

export type LagoonBuild = {
  name: string
  // Lagoon's own status: new, pending, queued, running, complete, failed, error, cancelled.
  status: string
  state: LagoonBuildState
  step: string | undefined
  // Milliseconds since the epoch.
  createdAt: number | undefined
  startedAt: number | undefined
  completedAt: number | undefined
  url: string | undefined
}

// `isPrimary`: the environment's main route, the one a collapsed row links.
export type LagoonService = { label: string; url: string; isPrimary: boolean }

export type LagoonEnvironment = {
  name: string
  type: string
  isProduction: boolean
  // The environment the session's git branch deploys to.
  isCurrent: boolean
  title: string | undefined
  // The cluster it runs on (`ch4.amazee.io`), as Lagoon names it.
  cluster: string | undefined
  build: LagoonBuild | undefined
  services: LagoonService[]
}

export type LagoonSnapshot = {
  project: string
  environments: LagoonEnvironment[]
  // When the environments were last read; undefined before the first good read.
  fetchedAt: number | undefined
  // Why the last read failed; the environments are then the last good ones.
  error: string | undefined
}

// Which Lagoon project the session's root deploys to.
export type LagoonLookup =
  | { root: string; status: 'pending' }
  | { root: string; status: 'found'; project: string }
  | { root: string; status: 'none' }
  | { root: string; status: 'error'; error: string }

// Who the lagoon CLI acts as, on which of its configured instances.
export type LagoonIdentity = {
  instance: string | undefined
  email: string | undefined
  error: string | undefined
  // The error reads as a login problem (expired token, unknown SSH key).
  isLoggedOut: boolean
}

export type LagoonWindow = { name: string; url: string | undefined; from: number; until: number | undefined; isInProgress: boolean }

// A Statuspage page (status.amazee.io): overall status, open incidents, the
// project's cluster, and each region's next maintenance window.
export type LagoonPlatform = {
  name: string
  url: string
  indicator: string
  description: string
  incidents: { name: string; url: string | undefined; impact: string }[]
  cluster: { name: string; region: string | undefined; status: string; next: LagoonWindow | undefined } | undefined
  // The Lagoon cluster the page was read for (`ch4.amazee.io`).
  clusterKey: string | undefined
  regions: { name: string; next: LagoonWindow | undefined }[]
  fetchedAt: number
  error: string | undefined
}

// The last command Claude ran against an environment, and whether it failed.
export type LagoonTarget = { project: string; environment: string; command: string; at: number; isFailed: boolean }

declare module 'claude-code' {
  interface PluginState {
    'lagoon-watch': {
      lookup: LagoonLookup | null
      snapshot: LagoonSnapshot | null
      lastCommand: LagoonTarget | null
      identity: LagoonIdentity | null
      platform: LagoonPlatform | null
      isShowingRegions: boolean
    }
  }
}
