import { z } from 'zod';

import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';

import { JwtDefaultGuard } from '@common/guards/jwt-guards';

import { XrayService } from './xray.service';

const requestSchema = z
    .object({
        id: z.uuid(),
        action: z.enum([
            'install',
            'rollback',
            'bundled',
            'profile',
            'start',
            'stop',
            'restart',
            'check',
        ]),
        release: z
            .object({
                url: z.url().max(2048),
                sha256: z.string().regex(/^[a-f0-9]{64}$/),
                build: z.string().max(100),
                arch: z.enum(['amd64', 'arm64']),
            })
            .strict()
            .optional(),
    })
    .strict();

@UseGuards(JwtDefaultGuard)
@Controller('xray/managed-core')
export class ManagedCoreController {
    constructor(private readonly xray: XrayService) {}
    @Get()
    async status() {
        return { response: await this.xray.getManagedCoreStatus() };
    }
    @Post('actions')
    async action(@Body() body: unknown) {
        const parsed = requestSchema.safeParse(body);
        if (!parsed.success) throw new BadRequestException('Invalid core operation');
        return { response: await this.xray.queueManagedCoreAction(parsed.data) };
    }
}
