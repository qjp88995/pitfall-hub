export const SEVERITIES = ['low', 'medium', 'high'] as const
export const STATUSES = ['active', 'outdated', 'archived'] as const

export type Severity = (typeof SEVERITIES)[number]
export type PitfallStatus = (typeof STATUSES)[number]

export interface Pitfall {
  id: string
  title: string
  /** What was observed: error message, wrong behaviour. */
  symptom: string
  /** Root cause, once understood. */
  cause: string
  /** What actually fixed it. Markdown. */
  solution: string
  /** How to avoid hitting it again. */
  prevention: string
  tags: string[]
  /** Versions / OS / runtime the pitfall was seen on, e.g. "next@15.1, node 22, WSL2". */
  environment: string
  /** The most distinctive line of the error output, used for exact duplicate detection. */
  errorSignature: string
  sourceProject: string
  sourceAgent: string
  severity: Severity
  status: PitfallStatus
  hitCount: number
  helpfulCount: number
  createdAt: string
  updatedAt: string
  lastHitAt: string | null
}

export type PitfallInput = Pick<Pitfall, 'title' | 'solution'> &
  Partial<
    Pick<
      Pitfall,
      | 'symptom'
      | 'cause'
      | 'prevention'
      | 'tags'
      | 'environment'
      | 'errorSignature'
      | 'sourceProject'
      | 'sourceAgent'
      | 'severity'
      | 'status'
    >
  >

export type PitfallPatch = Partial<Omit<PitfallInput, 'sourceProject' | 'sourceAgent'>>

export interface SearchOptions {
  q?: string
  /** Entry must carry at least one of these tags. */
  tags?: string[]
  /** Defaults to ['active']. Pass [] for all. */
  status?: PitfallStatus[]
  project?: string
  limit?: number
  offset?: number
}

export interface SearchHit extends Pitfall {
  score: number | null
}

export interface SearchResult {
  items: SearchHit[]
  total: number
}
