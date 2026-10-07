import type { Request } from 'express';

import { ExecutionContext, Logger, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

export class JwtDefaultGuard extends AuthGuard('registeredUserJWT') {
    private readonly logger = new Logger(JwtDefaultGuard.name);

    handleRequest<TUser = unknown>(
        err: unknown,
        user: TUser,
        info: unknown,
        context: ExecutionContext,
    ): TUser {
        if (info instanceof Error || err || !user) {
            const request = context.switchToHttp().getRequest<Request>();

            this.logger.error(
                `Incorrect SECRET_KEY or JWT! Request denied. Path: ${request.path}, IP: ${request.ip}`,
            );

            throw new UnauthorizedException('Unauthorized');
        }
        return user;
    }
}
