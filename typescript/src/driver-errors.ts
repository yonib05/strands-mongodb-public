import { StorageError } from '@strands-agents/sdk'
import { type Collection, MongoServerError } from 'mongodb'

/** Server code for a namespace that does not exist. Not an error when reading indexes. */
export const COLLECTION_ABSENT = 26

/**
 * Renders a collection's namespace for a message or a log line.
 *
 * @param collection - The collection to name
 * @returns `<database>.<collection>`
 */
export function namespaceOf(collection: Collection): string {
  return `${collection.dbName}.${collection.collectionName}`
}

/**
 * Reads the server's error code off a thrown value.
 *
 * @param error - Whatever a driver call threw
 * @returns The code, or `undefined` when the error did not come from the server
 */
export function serverCode(error: unknown): number | undefined {
  return error instanceof MongoServerError && typeof error.code === 'number' ? error.code : undefined
}

/**
 * Wraps a failed driver call, chaining it as the cause.
 *
 * @param what - What was being done, such as `reading indexes on db.coll`
 * @param error - Whatever the driver call threw
 * @returns The error to throw
 */
export function failure(what: string, error: unknown): StorageError {
  const reason = error instanceof Error ? error.message : String(error)
  return new StorageError(`strands_mongodb: ${what} failed: ${reason}`, { cause: error })
}

/**
 * Awaits a driver call, rethrowing a failure through {@link failure}.
 *
 * @param work - The pending driver call
 * @param what - What is being done, for the message
 * @returns Whatever `work` resolves to
 * @throws StorageError if `work` rejects
 */
export async function guard<T>(work: Promise<T>, what: string): Promise<T> {
  try {
    return await work
  } catch (error) {
    throw failure(what, error)
  }
}
