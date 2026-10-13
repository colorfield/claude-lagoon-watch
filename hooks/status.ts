import type { LagoonPlatform, LagoonWindow } from '../types'
import { webUrl } from './lagoon'

// Reads a Statuspage summary (/api/v2/summary.json) into what the pane
// shows. Pure, so the tests read it.

type Component = { id: string; name: string; status: string; group?: boolean; group_id?: string | null }
type Maintenance = {
  name: string
  status: string
  scheduled_for: string
  scheduled_until?: string | null
  shortlink?: string
  components: { id: string; name: string }[]
}
type Summary = {
  page: { name: string; url: string }
  status: { indicator: string; description: string }
  components: Component[]
  incidents: { name: string; impact: string; shortlink?: string; status: string }[]
  scheduled_maintenances: Maintenance[]
}

const OPEN = new Set(['scheduled', 'in_progress', 'verifying'])

export function platform(json: string, cluster: string | undefined, now: number): LagoonPlatform {
  const summary = JSON.parse(json) as Summary
  const groups = new Map(summary.components.filter(one => one.group).map(one => [one.id, one.name]))
  const members = summary.components.filter(one => !one.group)
  const windows = summary.scheduled_maintenances
    .filter(one => OPEN.has(one.status))
    .map(one => ({ maintenance: one, window: toWindow(one, now) }))
    .filter(({ window }) => window.until === undefined || window.until > now)
    .sort((a, b) => a.window.from - b.window.from)

  const nextFor = (ids: ReadonlySet<string>): LagoonWindow | undefined =>
    windows.find(({ maintenance }) => maintenance.components.some(one => ids.has(one.id)))?.window

  const component = clusterComponent(members, cluster)
  const regions = [...groups].map(([id, name]) => ({
    name,
    next: nextFor(new Set(members.filter(one => one.group_id === id).map(one => one.id))),
  }))

  return {
    name: summary.page.name,
    // Not a web address: the name is drawn as plain text (a blank href).
    url: webUrl(summary.page.url) ?? '',
    indicator: summary.status.indicator,
    description: summary.status.description,
    // The page says "Service Under Maintenance" while any region is: name which.
    inMaintenance: [...new Set(windows
      .filter(({ window }) => window.isInProgress)
      .flatMap(({ maintenance }) => maintenance.components.map(one => one.name)))],
    incidents: summary.incidents
      .filter(one => one.status !== 'resolved' && one.status !== 'postmortem')
      .map(one => ({ name: one.name, url: webUrl(one.shortlink), impact: one.impact })),
    cluster: component === undefined
      ? undefined
      : {
        name: component.name,
        region: component.group_id == null ? undefined : groups.get(component.group_id),
        status: component.status,
        next: nextFor(new Set([component.id])),
      },
    clusterKey: cluster,
    regions,
    fetchedAt: now,
    error: undefined,
  }
}

function toWindow(maintenance: Maintenance, now: number): LagoonWindow {
  const from = Date.parse(maintenance.scheduled_for)
  const until = maintenance.scheduled_until ? Date.parse(maintenance.scheduled_until) : undefined
  return {
    name: maintenance.name,
    url: webUrl(maintenance.shortlink),
    from,
    until,
    isInProgress: maintenance.status !== 'scheduled' || (from <= now && (until === undefined || now < until)),
  }
}

// The status component of a Lagoon cluster: `ch4.amazee.io` is `ch4.lagoon`.
export function clusterComponent<C extends { name: string }>(components: readonly C[], cluster: string | undefined): C | undefined {
  const short = cluster?.split('.')[0]?.toLowerCase()
  if (!short) return undefined
  return components.find(one => one.name.toLowerCase() === `${short}.lagoon`)
    ?? components.find(one => one.name.toLowerCase().split(/[.\s:]/)[0] === short)
}

// "Tue 13 Oct 23:00–04:00" in the person's time zone; "until 04:00" once it runs.
export function windowText(window: LagoonWindow, timeZone: string | undefined): string {
  const day = format(window.from, timeZone, { weekday: 'short', day: 'numeric', month: 'short' })
  const from = format(window.from, timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const until = window.until === undefined ? undefined : format(window.until, timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  if (window.isInProgress) return until === undefined ? 'in progress' : `in progress until ${until}`
  return until === undefined ? `${day} ${from}` : `${day} ${from}–${until}`
}

function format(ms: number, timeZone: string | undefined, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone }).format(ms).replace(',', '')
  } catch {
    // An unknown zone: UTC, said so.
    return `${new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' }).format(ms).replace(',', '')} UTC`
  }
}

// /etc/localtime resolves to …/zoneinfo/Europe/Zurich on macOS and Linux.
export function zoneOf(realPath: string | undefined): string | undefined {
  return realPath === undefined ? undefined : /zoneinfo\/(.+)$/.exec(realPath)?.[1]
}

export const INDICATOR: Record<string, { icon: string; color: string }> = {
  none: { icon: '✓', color: 'success' },
  minor: { icon: '▲', color: 'warning' },
  major: { icon: '✗', color: 'error' },
  critical: { icon: '✗', color: 'error' },
  maintenance: { icon: '◆', color: 'warning' },
}

export function componentText(status: string): string {
  return status.replace(/_/g, ' ')
}
