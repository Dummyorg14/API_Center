// =============================================================================
// src/shared/middleware/morgan.middleware.ts — HTTP request logging
// =============================================================================
// NestJS middleware that logs every HTTP request using Morgan + Winston.
// =============================================================================

import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import morgan from 'morgan';
import { LoggerService } from '../logger.service';

@Injectable()
export class MorganMiddleware implements NestMiddleware {
  private readonly morganHandler: ReturnType<typeof morgan>;

  constructor(private readonly logger: LoggerService) {
    this.morganHandler = morgan('combined', {
      stream: this.logger.morganStream,
    });
  }

  use(req: Request, res: Response, next: NextFunction) {
    this.morganHandler(req, res, next);
  }
}
