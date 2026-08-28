import { ApiError } from '../../shared/http/api-error';

export type SupportedImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** Magic-byte sniffing for the image types metadata may reference — the declared MIME (if any)
 * must agree with the bytes, and bytes that are none of these are rejected outright (검증 개선안
 * §5: "허용 MIME, magic-byte 검증"). */
export function sniffImageMime(bytes: Buffer): SupportedImageMime | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (bytes.length >= 6) {
    const header = bytes.subarray(0, 6).toString('ascii');
    if (header === 'GIF87a' || header === 'GIF89a') {
      return 'image/gif';
    }
  }
  return null;
}

/** Decodes and validates `imageBase64`: decoded size ≤ `maxBytes`, recognizable image magic
 * bytes, and (when declared) a matching MIME type. Throws stable 4xx `ApiError`s. */
export function decodeAndValidateImage(
  imageBase64: string,
  declaredMime: SupportedImageMime | undefined,
  maxBytes: number,
): { bytes: Buffer; mime: SupportedImageMime } {
  // 3 base64 chars ≈ 4 bytes… rather: 4 chars → 3 bytes. Reject before allocating when the encoded
  // length alone already exceeds the limit.
  const upperBound = Math.floor((imageBase64.length * 3) / 4);
  if (upperBound > maxBytes + 3) {
    throw new ApiError('IMAGE_TOO_LARGE', `image exceeds the ${maxBytes}-byte limit`, 413);
  }
  const bytes = Buffer.from(imageBase64, 'base64');
  if (bytes.length === 0) {
    throw new ApiError('IMAGE_EMPTY', 'imageBase64 decodes to zero bytes', 400);
  }
  if (bytes.length > maxBytes) {
    throw new ApiError('IMAGE_TOO_LARGE', `image exceeds the ${maxBytes}-byte limit`, 413);
  }
  const sniffed = sniffImageMime(bytes);
  if (!sniffed) {
    throw new ApiError('IMAGE_TYPE_UNSUPPORTED', 'image bytes are not PNG, JPEG, WebP or GIF', 415);
  }
  if (declaredMime && declaredMime !== sniffed) {
    throw new ApiError(
      'IMAGE_TYPE_MISMATCH',
      `imageMimeType ${declaredMime} does not match the image bytes (${sniffed})`,
      415,
    );
  }
  return { bytes, mime: sniffed };
}
