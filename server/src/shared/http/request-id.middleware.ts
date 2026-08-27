import { randomUUID } from 'node:crypto';

import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

export interface RequestWithId extends Request {
  requestId: string;
}

/** Assigns a fresh request id to every inbound request — the internal API does not trust a
 * caller-supplied one — and echoes it back so Backend can correlate a response/error with its
 * request in our logs. */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = randomUUID();
    (req as RequestWithId).requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    next();
  }
}
