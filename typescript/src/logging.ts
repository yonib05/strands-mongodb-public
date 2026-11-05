import type { Logger } from '@strands-agents/sdk'

/** Every event name this package logs, identical to the Python package's. */
export type LogEvent =
  | 'retry_writes_disabled'
  | 'attribution_not_visible'
  | 'closed_loop_client_dropped'
  | 'reserved_key_collision'
  | 'no_search_setup'
  | 'tier_unavailable'
  | 'tier_building'
  | 'below_vector'
  | 'bound_declined_fusion'
  | 'score_bound_applied'
  | 'creating_indexes'
  | 'creating_search_index'
  | 'search_index_status'
  | 'attribute_dropped'

/** Optional context rendered into a log line by {@link logFields}. */
export interface LogContext {
  namespace?: string
  tier?: string
}

/** The SDK's default behaviour: `warn` and `error` to `console`, `debug` and `info` silent. */
export const defaultLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
}

/**
 * Renders the structured tail of a log line: `event=<name>, namespace=<db.coll>, tier=<tier>`.
 *
 * @param event - The event being logged
 * @param context - Optional namespace and tier; absent keys are omitted
 * @returns The rendered fields
 */
export function logFields(event: LogEvent, context: LogContext = {}): string {
  const parts = [`event=${event}`]
  if (context.namespace !== undefined) parts.push(`namespace=${context.namespace}`)
  if (context.tier !== undefined) parts.push(`tier=${context.tier}`)
  return parts.join(', ')
}
