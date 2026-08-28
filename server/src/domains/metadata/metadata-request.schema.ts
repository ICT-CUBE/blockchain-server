import { z } from 'zod';

/** Strict base64 (standard alphabet, correct padding, no whitespace) — rejected before decoding
 * so a malformed body cannot smuggle bytes past the size check (검증 개선안 §5 option 2). */
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

/** Upper bound on the *encoded* payload the schema accepts; the exact decoded-byte limit
 * (`METADATA_IMAGE_MAX_BYTES`) and MIME sniffing are enforced by `MetadataService` against config. */
export const METADATA_IMAGE_BASE64_HARD_MAX_CHARS = 16 * 1024 * 1024;

/**
 * TASK-13 §4 input allowlist for the immutable core metadata. `.strict()` is the PII/secret
 * guard: any key outside this list (userId, phone, NFC/QR values, …) is a 400, never silently
 * dropped. Blockchain Server uploads the image itself (`imageBase64`) — 검증 개선안 §5 option 2 —
 * so the payload is bounded and the bytes are content-sniffed before pinning.
 */
export const prepareMetadataRequestSchema = z
  .object({
    tokenId: z.number().int().min(1).max(10000),
    cubeNumber: z.string().min(1).max(64),
    publicGrade: z.string().min(1).max(64),
    imageBase64: z
      .string()
      .min(1)
      .max(METADATA_IMAGE_BASE64_HARD_MAX_CHARS)
      .regex(STRICT_BASE64, 'must be strict standard base64'),
    /** Declared MIME type; must agree with the decoded bytes' magic number. */
    imageMimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']).optional(),
    benefitReferenceId: z.string().min(1).max(200),
  })
  .strict();

export type PrepareMetadataRequest = z.infer<typeof prepareMetadataRequestSchema>;
