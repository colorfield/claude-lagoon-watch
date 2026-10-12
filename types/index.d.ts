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

export type LagoonService = { label: string; url: string }

export type LagoonEnvironment = {
  name: string
  type: string
  isProduction: boolean
  // The environment the session's git branch deploys to.
  isCurrent: boolean
  title: string | undefined
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

export type LagoonTarget = { environment: string; command: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'lagoon-watch': { lookup: LagoonLookup | null; snapshot: LagoonSnapshot | null; target: LagoonTarget | null }
  }
}
