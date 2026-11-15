import { z } from 'zod';

import { REST_API } from '../../api';
import { NetworkAddressesSchema } from '../../models';

export namespace GetNetworkAddressesCommand {
    export const url = REST_API.STATS.GET_NETWORK_ADDRESSES;

    export const ResponseSchema = z.object({
        response: z.object({
            addresses: NetworkAddressesSchema,
            complete: z.literal(true),
        }),
    });

    export type Response = z.infer<typeof ResponseSchema>;
}
