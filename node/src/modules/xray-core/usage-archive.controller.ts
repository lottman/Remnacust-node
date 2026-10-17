import {
    BadRequestException,
    Body,
    Controller,
    HttpCode,
    Header,
    Post,
    ServiceUnavailableException,
    UseGuards,
} from '@nestjs/common';

import { JwtDefaultGuard } from '@common/guards/jwt-guards';

import { captureUsageArchive, usageArchiveRequest } from './usage-archive';

@UseGuards(JwtDefaultGuard)
@Controller('xray/usage-receipts/archive')
export class UsageArchiveController {
    @Post()
    @HttpCode(200)
    @Header('Cache-Control', 'no-store')
    async capture(@Body() body: unknown) {
        const parsed = usageArchiveRequest.safeParse(body);
        if (!parsed.success) throw new BadRequestException('Invalid usage archive request');
        try {
            return { response: await captureUsageArchive(parsed.data) };
        } catch {
            throw new ServiceUnavailableException('Usage outbox cannot be read safely');
        }
    }
}
