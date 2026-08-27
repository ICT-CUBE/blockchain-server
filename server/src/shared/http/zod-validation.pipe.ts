import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

import { ApiError } from './api-error';

/** Validates (and, per zod's usual behavior, normalizes/coerces) a request body against `schema`.
 * Used per-route as `@Body(new ZodValidationPipe(mintRequestSchema))` — kept per-schema rather than
 * a single global pipe so each endpoint's DTO shape stays explicit at the call site. */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const message = result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      throw new ApiError('VALIDATION_FAILED', message, 400);
    }
    return result.data;
  }
}
