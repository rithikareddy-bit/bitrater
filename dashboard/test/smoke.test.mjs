import { describe, it, expect } from 'vitest';
import { parseSourceUrl } from '@/lib/sourceUrl';

describe('harness', () => {
  it('resolves the @/ alias and runs existing code', () => {
    expect(parseSourceUrl('s3://b/k.mp4')).toMatchObject({ provider: 's3', bucket: 'b', key: 'k.mp4' });
  });
});
