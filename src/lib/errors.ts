// src/lib/errors.ts
// Typed errors. The API layer maps these onto HTTP statuses (400/404/409/503).

export class VaultError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, status: number, code: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends VaultError {
  constructor(message: string, details?: unknown) {
    super(message, 400, "INVALID_REQUEST", details);
  }
}

export class NotFoundError extends VaultError {
  constructor(message: string, details?: unknown) {
    super(message, 404, "NOT_FOUND", details);
  }
}

export class ConflictError extends VaultError {
  constructor(message: string, details?: unknown, code = "CONFLICT") {
    super(message, 409, code, details);
  }
}

export class QuorumError extends VaultError {
  constructor(message: string, details?: unknown, code = "QUORUM_UNAVAILABLE") {
    super(message, 503, code, details);
  }
}

export class NodeUnavailableError extends VaultError {
  readonly nodeName: string;
  readonly reason: string;

  constructor(nodeName: string, reason: string) {
    super(`Node ${nodeName} is unreachable (${reason})`, 503, "NODE_UNAVAILABLE", {
      node: nodeName,
      reason,
    });
    this.nodeName = nodeName;
    this.reason = reason;
  }
}

// Thrown by storage backends when a key does not exist (distinct from "node unreachable").
export class StorageNotFoundError extends Error {
  constructor(key: string) {
    super(`Storage key not found: ${key}`);
    this.name = "StorageNotFoundError";
  }
}

// Prisma unique-constraint violation (error code P2002).
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}