// =============================================================================
// Unit tests — DeprecateServiceDto validation
// =============================================================================

import { validate } from 'class-validator';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { plainToInstance } = require('class-transformer');
import { DeprecateServiceDto } from './deprecate-service.dto';

describe('DeprecateServiceDto', () => {
  const transform = (plain: Record<string, unknown>) =>
    plainToInstance(DeprecateServiceDto, plain);

  it('should accept valid sunsetDate and replacementService', async () => {
    const dto = transform({
      sunsetDate: '2026-06-01T00:00:00.000Z',
      replacementService: 'payments-v2',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should accept empty body (all optional)', async () => {
    const dto = transform({});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('should reject invalid sunsetDate', async () => {
    const dto = transform({ sunsetDate: 'not-a-date' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].constraints).toBeDefined();
  });

  it('should reject replacementService with uppercase or spaces', async () => {
    const dto = transform({ replacementService: 'Bad Service Name' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should accept replacementService with hyphens and digits', async () => {
    const dto = transform({ replacementService: 'api-v2-service-3' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});
