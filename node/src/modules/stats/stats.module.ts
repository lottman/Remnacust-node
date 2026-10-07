import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';

import { GeocheckService } from './geocheck.service';
import { StatsController } from './stats.controller';
import { XrayModule } from '../xray-core/xray.module';
import { RuntimeService } from './runtime.service';
import { StatsService } from './stats.service';
@Module({
    imports: [CqrsModule, XrayModule],
    providers: [StatsService, GeocheckService, RuntimeService],
    controllers: [StatsController],
})
export class StatsModule {}
