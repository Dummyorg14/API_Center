import { Module } from '@nestjs/common';
import { DemandController } from './demand.controller';
import { DemandService } from './demand.service';

@Module({
  controllers: [DemandController],
  providers: [DemandService],
})
export class AppModule {}
