export class DomainError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
    public readonly code = 'DOMAIN_ERROR',
  ) {
    super(message);
  }
}

export function requireValue<T>(
  value: T | null | undefined,
  message: string,
  statusCode = 404,
): T {
  if (value === null || value === undefined) {
    throw new DomainError(message, statusCode, 'NOT_FOUND');
  }

  return value;
}
