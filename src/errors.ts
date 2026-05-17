export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode = 500,
    public readonly metadata?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, code = 'NOT_FOUND', metadata?: Record<string, unknown>) {
    super(message, code, 404, metadata);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = 'CONFLICT', metadata?: Record<string, unknown>) {
    super(message, code, 409, metadata);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, code = 'VALIDATION_ERROR', metadata?: Record<string, unknown>) {
    super(message, code, 400, metadata);
  }
}

export class ConfigurationError extends AppError {
  constructor(message: string, code = 'CONFIGURATION_ERROR', metadata?: Record<string, unknown>) {
    super(message, code, 500, metadata);
  }
}
