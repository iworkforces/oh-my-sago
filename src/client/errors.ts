import { ErrorName } from "../enums.js";

export class BridgeError extends Error {
  override readonly name: typeof ErrorName.Bridge = ErrorName.Bridge;
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function unsupported(operation: string): never {
  throw new BridgeError(501, `Legacy operation is unsupported: ${operation}`);
}

export function assertNever(value: never): never {
  throw new BridgeError(500, `Unexpected native variant: ${String(value)}`);
}

export function errorResponse(error: Error): Response {
  // The runtime names a missing session instead of giving it a status; legacy callers expect 404.
  const status =
    error instanceof BridgeError
      ? error.status
      : error.name === ErrorName.SessionNotFound
        ? 404
        : 500;
  return Response.json(
    {
      name: status === 404 ? ErrorName.NotFound : ErrorName.BadRequest,
      data: { message: error.message },
    },
    { status },
  );
}
