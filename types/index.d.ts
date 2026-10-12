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
  fetchedAt: number
  error: string | undefined
}

export type LagoonTarget = { environment: string; command: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'lagoon-watch': { snapshot: LagoonSnapshot | null; target: LagoonTarget | null }
  }
}
