import { Module } from '@nestjs/common';
import { LogisticsController } from './logistics.controller';
import { LogisticsJwtGuard } from './logistics-jwt.guard';

@Module({
  controllers: [LogisticsController],
  providers: [LogisticsJwtGuard],
})
export class AppModule {}
