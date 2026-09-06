export class StatewellError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) { super(message); }
}
export function failure(error: unknown) {
  return { error: { ...(error instanceof StatewellError && error.details !== undefined ? { details: error.details } : {}), code: error instanceof StatewellError ? error.code : "INTERNAL_ERROR", message: error instanceof Error ? error.message : "The operation failed." } };
}
