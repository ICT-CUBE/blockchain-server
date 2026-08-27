import { z } from 'zod';

/** The full allowlist of fields TASK-13's immutable metadata JSON is ever built from (TASK-13 §4:
 * "tokenId/CUBE 번호/공개 등급/이미지·혜택 참조 ID만 포함"). `.strict()` rejects any request carrying
 * an unexpected extra field outright — that rejection *is* the "민감정보 검사" (sensitive-field
 * check): nothing not on this allowlist can ever reach the canonical JSON, because nothing else
 * can even pass validation. `imageBase64` is pinned as its own dependency; the core JSON only ever
 * references it by the resulting CID. */
export const prepareMetadataRequestSchema = z
  .object({
    tokenId: z.number().int().min(1).max(10000),
    cubeNumber: z.string().min(1),
    publicGrade: z.string().min(1),
    imageBase64: z.string().min(1),
    benefitReferenceId: z.string().min(1),
  })
  .strict();

export type PrepareMetadataRequest = z.infer<typeof prepareMetadataRequestSchema>;
