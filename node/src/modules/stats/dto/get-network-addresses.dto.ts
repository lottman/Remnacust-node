import { createZodDto } from 'nestjs-zod';

import { GetNetworkAddressesCommand } from '@libs/contracts/commands';

export class GetNetworkAddressesResponseDto extends createZodDto(
    GetNetworkAddressesCommand.ResponseSchema,
) {}
