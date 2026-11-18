import { ErrorName } from "../enums.js";

export class BridgeError extends Error {
  override readonly name = ErrorName.Bridge;
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
  return Response.json(
    { name: ErrorName.BadRequest, data: { message: error.message } },
    { status: error instanceof BridgeError ? error.status : 500 },
  );
}
