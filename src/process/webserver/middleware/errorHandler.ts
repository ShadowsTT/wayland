/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ErrorRequestHandler, Response } from 'express';

/**
 * Application Error Class - Custom error class with status code and error code
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode = 500, code = 'internal_error') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * Error Command Interface - Define how error responses are executed
 */
interface ErrorCommand {
  execute(res: Response): void;
}

/**
 * JSON Error Command - Return error response in JSON format
 */
class JsonErrorCommand implements ErrorCommand {
  constructor(
    private readonly statusCode: number,
    private readonly payload: Record<string, unknown>
  ) {}

  execute(res: Response): void {
    res.status(this.statusCode).json({ success: false, ...this.payload });
  }
}

/**
 * Global error handling middleware
 *
 * Handles all uncaught errors and returns formatted error responses
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const isAppError = err instanceof AppError;
  const statusCode = isAppError ? err.statusCode : 500;
  const code = isAppError ? err.code : 'internal_error';
  const message = isAppError ? err.message : 'Internal server error';

  // Only log unexpected errors
  if (!isAppError) {
    console.error('[Error]', err);
  }

  const command = new JsonErrorCommand(statusCode, {
    error: message,
    code,
  });

  command.execute(res);
};

/**
 * Create application error
 * @param message - Error message
 * @param statusCode - HTTP status code
 * @param code - Error code
 * @returns AppError instance
 */
export const createAppError = (message: string, statusCode = 400, code = 'bad_request'): AppError => {
  return new AppError(message, statusCode, code);
};
