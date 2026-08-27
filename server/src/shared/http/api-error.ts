import { HttpException } from '@nestjs/common';

/** The only shape errors are allowed to reach a caller in: a stable `code` a client can branch on,
 * and a `message` that is always safe to show/log (TASK-04/06 §4 공통 변경 사항: "안정적인 error
 * code와 안전한 message를 분리하고 내부 stack/secret은 응답 제외"). Never construct one with a raw
 * driver/library error message — write a message you'd be fine putting in the response. */
export class ApiError extends HttpException {
  public readonly code: string;

  constructor(code: string, message: string, status: number) {
    super({ code, message }, status);
    this.code = code;
  }
}
