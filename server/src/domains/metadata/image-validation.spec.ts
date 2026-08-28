import { ApiError } from '../../shared/http/api-error';
import { decodeAndValidateImage, sniffImageMime } from './image-validation';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(32, 3)]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.alloc(4, 0),
  Buffer.from('WEBP', 'ascii'),
  Buffer.alloc(32, 4),
]);

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) {
      return error.code;
    }
    throw error;
  }
  throw new Error('expected an ApiError');
}

describe('image-validation (검증 개선안 §5 option 2 boundaries)', () => {
  it('sniffs the four supported types', () => {
    expect(sniffImageMime(PNG)).toBe('image/png');
    expect(sniffImageMime(JPEG)).toBe('image/jpeg');
    expect(sniffImageMime(GIF)).toBe('image/gif');
    expect(sniffImageMime(WEBP)).toBe('image/webp');
    expect(sniffImageMime(Buffer.from('not an image'))).toBeNull();
  });

  it('accepts a valid image within the limit and reports its sniffed type', () => {
    const result = decodeAndValidateImage(PNG.toString('base64'), undefined, 1024);
    expect(result.mime).toBe('image/png');
    expect(result.bytes.equals(PNG)).toBe(true);
  });

  it('rejects an empty payload', () => {
    expect(codeOf(() => decodeAndValidateImage('', undefined, 1024))).toBe('IMAGE_EMPTY');
  });

  it('rejects bytes that are not a recognised image', () => {
    expect(
      codeOf(() =>
        decodeAndValidateImage(Buffer.from('plain text bytes').toString('base64'), undefined, 1024),
      ),
    ).toBe('IMAGE_TYPE_UNSUPPORTED');
  });

  it('rejects a declared MIME that disagrees with the bytes (MIME spoofing)', () => {
    expect(codeOf(() => decodeAndValidateImage(PNG.toString('base64'), 'image/jpeg', 1024))).toBe(
      'IMAGE_TYPE_MISMATCH',
    );
  });

  it('enforces the decoded size limit at the boundary', () => {
    const exactly = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(56, 9)]); // 64 bytes
    expect(decodeAndValidateImage(exactly.toString('base64'), undefined, 64).bytes.length).toBe(64);
    const oneOver = Buffer.concat([exactly, Buffer.alloc(1, 9)]);
    expect(codeOf(() => decodeAndValidateImage(oneOver.toString('base64'), undefined, 64))).toBe(
      'IMAGE_TOO_LARGE',
    );
  });

  it('rejects an oversized payload before decoding it', () => {
    const huge = 'A'.repeat(4 * 1024); // 3 KiB decoded
    expect(codeOf(() => decodeAndValidateImage(huge, undefined, 1024))).toBe('IMAGE_TOO_LARGE');
  });
});
