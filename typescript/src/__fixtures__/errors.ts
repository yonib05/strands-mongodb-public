import { MongoServerError } from 'mongodb'

/** The error `run` throws; fails the test when it returns instead. */
export function errorOf(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a throw')
}

/** The error `pending` rejects with; fails the test when it resolves instead. */
export async function rejectionOf(pending: Promise<unknown>): Promise<Error> {
  try {
    await pending
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a rejection')
}

/** A server error carrying `code`, as the driver raises one. */
export function serverError(code: number, message = 'probed'): MongoServerError {
  return new MongoServerError({ message, code })
}
