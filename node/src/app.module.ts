import { ChannelCredentials } from 'nice-grpc';

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';

import { XtlsSdkNestjsModule } from '@remnawave/xtls-sdk-nestjs';

import { TypedConfigService } from '@common/config/app-config/typed-config.service';
import { CommonConfigModule } from '@common/config/common-config';
import { getJWTConfig } from '@common/config/jwt/jwt.config';
import { JwtStrategy } from '@common/guards/jwt-guards/strategies/validate-token';
import { privateXtlsConnectionUrl } from '@common/utils/private-xtls-socket';

import { InternalModule } from './modules/internal/internal.module';
import { RemnawaveNodeModules } from './modules/remnawave-node.modules';

@Module({
    imports: [
        CommonConfigModule,
        ScheduleModule.forRoot(),
        XtlsSdkNestjsModule.forRootAsync({
            imports: [],
            inject: [TypedConfigService],
            useFactory: (configService: TypedConfigService) => {
                return {
                    connectionUrl: privateXtlsConnectionUrl(
                        configService.getOrThrow('XTLS_API_SOCKET_PATH'),
                    ),
                    credentials: ChannelCredentials.createInsecure(),
                    options: {
                        'grpc.max_receive_message_length': 100_000_000, // 100MB
                    },
                };
            },
        }),
        RemnawaveNodeModules,
        InternalModule,
        JwtModule.registerAsync(getJWTConfig()),
    ],
    providers: [JwtStrategy],
    exports: [],
})
export class AppModule {}
