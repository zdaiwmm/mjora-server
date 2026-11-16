import { createHash } from 'node:crypto';
import { parseMediaEditBody } from 'src/utils/media-edit.js';
import fixture from 'test/fixtures/media-edit-video.json' with { type: 'json' };

describe('media-edit wire boundary', () => {
  it('rejects oversized, invalid UTF-8 and excessive nesting before schema handling', () => {
    expect(() => parseMediaEditBody(Buffer.alloc(256 * 1024 + 1, 32))).toThrow('Http Exception');
    expect(() => parseMediaEditBody(Buffer.from([0x22, 0xff, 0x22]))).toThrow('Bad Request Exception');
    const deep = Buffer.from('['.repeat(17) + '0' + ']'.repeat(17));
    try {
      parseMediaEditBody(deep);
      throw new Error('expected rejection');
    } catch (error) {
      expect((error as { getResponse(): unknown }).getResponse()).toEqual({ code: 'JSON_TOO_DEEP' });
    }
  });

  it('does not turn a malformed decimal time into an unhandled BigInt exception', () => {
    const value = {
      schemaVersion: 1,
      kind: 'video',
      source: {
        sourceRevision: 's',
        baselineKind: 'foreignCurrent',
        components: [],
        displayWidth: 1,
        displayHeight: 1,
        colorProfile: 'unknown',
        orientationRevision: 'o',
        duration: { value: '1.0', timescale: 1 },
        frameIndexRevision: 'f',
      },
    };
    expect(() => parseMediaEditBody(Buffer.from(JSON.stringify(value)))).toThrow('Http Exception');
  });

  it('rejects unsupported versions rather than silently accepting a partial v1 document', () => {
    const body = Buffer.from('{"schemaVersion":2,"futureField":{"keep":true}}');
    expect(() => parseMediaEditBody(body)).toThrow('Http Exception');
  });

  it('hashes exact received bytes while validating equivalent document values', () => {
    const compact = Buffer.from(JSON.stringify(fixture));
    const spaced = Buffer.from(JSON.stringify(fixture, null, 2));
    const first = parseMediaEditBody(compact),
      second = parseMediaEditBody(spaced);
    expect(first.intent).toEqual(second.intent);
    expect(first.requestHash).toBe(createHash('sha256').update(compact).digest('hex'));
    expect(second.requestHash).toBe(createHash('sha256').update(spaced).digest('hex'));
    expect(first.requestHash).not.toBe(second.requestHash);
  });
});
