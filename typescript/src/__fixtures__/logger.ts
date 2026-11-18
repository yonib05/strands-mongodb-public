import type { Logger } from '@strands-agents/sdk'

/** A log level of the SDK's `Logger`. */
export type Level = 'debug' | 'info' | 'warn' | 'error'

/** Keeps every line in call order, so the interleaving of levels can be asserted. */
export class RecordingLogger implements Logger {
  readonly records: Array<[Level, string]> = []
  debug = (...args: unknown[]): void => this.record('debug', args)
  info = (...args: unknown[]): void => this.record('info', args)
  warn = (...args: unknown[]): void => this.record('warn', args)
  error = (...args: unknown[]): void => this.record('error', args)

  lines(level: Level): string[] {
    return this.records.filter(([at]) => at === level).map(([, line]) => line)
  }

  private record(level: Level, args: unknown[]): void {
    this.records.push([level, args.map(String).join(' ')])
  }
}
