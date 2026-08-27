import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';

import { ApiError } from './api-error';
import type { RequestWithId } from './request-id.middleware';

interface ErrorResponseBody {
  code: string;
  message: string;
  requestId: string;
}

const logger = new Logger('ApiExceptionFilter');

/** Every error response — success or not, ours or a framework default — leaves this filter as
 * `{code, message, requestId}` only. Anything not already an `ApiError` is mapped to a safe,
 * generic code/message: an unexpected error's real message and stack are logged (server-side
 * only) but never returned (공통 변경 사항: "내부 stack/secret은 응답 제외"). */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<RequestWithId>();
    const requestId = request.requestId ?? 'unknown';

    if (exception instanceof ApiError) {
      const status = exception.getStatus();
      const body: ErrorResponseBody = { code: exception.code, message: exception.message, requestId };
      response.status(status).json(body);
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body: ErrorResponseBody = {
        code: `HTTP_${status}`,
        message: extractSafeHttpExceptionMessage(exception),
        requestId,
      };
      response.status(status).json(body);
      return;
    }

    logger.error(
      `Unhandled exception on request ${requestId}`,
      exception instanceof Error ? exception.stack : exception,
    );
    const body: ErrorResponseBody = { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId };
    response.status(500).json(body);
  }
}

function extractSafeHttpExceptionMessage(exception: HttpException): string {
  const body = exception.getResponse();
  if (typeof body === 'string') {
    return body;
  }
  if (typeof body === 'object' && body !== null && 'message' in body) {
    const message = body.message;
    if (typeof message === 'string') {
      return message;
    }
    if (Array.isArray(message)) {
      return message.filter((entry): entry is string => typeof entry === 'string').join('; ');
    }
  }
  return exception.message;
}
