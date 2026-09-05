export class StatewellError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function failure(error: unknown) {
  return { error: { code: error instanceof StatewellError ? error.code : "INTERNAL_ERROR", message: error instanceof Error ? error.message : "The operation failed." } };
}
