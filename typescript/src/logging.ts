import type { Logger } from '@strands-agents/sdk'
import type { MongoDBConfig } from './types.js'

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

/** Structured fields passed as the second argument of every log call. */
export interface LogFields {
  /** Which event this call reports. */
  event: LogEvent
  /** The `database.collection` the event concerns. */
  namespace?: string
  /** The search tier the event concerns. */
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
 * Picks the logger a config's stores write to.
 *
 * @param config - The connection config
 * @returns `config.logger`, or {@link defaultLogger} when it is absent
 */
export function resolveLogger(config: MongoDBConfig): Logger {
  return config.logger ?? defaultLogger
}

/**
 * Builds the fields object for a log call.
 *
 * @param event - The event being logged
 * @param extra - Optional namespace and tier
 * @returns The fields, without keys for absent values
 */
export function fields(event: LogEvent, extra: { namespace?: string; tier?: string } = {}): LogFields {
  const result: LogFields = { event }
  if (extra.namespace !== undefined) result.namespace = extra.namespace
  if (extra.tier !== undefined) result.tier = extra.tier
  return result
}
