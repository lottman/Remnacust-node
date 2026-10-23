import { z } from 'zod';

import { REST_API } from '../../api';

export namespace GetNodeHealthCheckCommand {
    export const url = REST_API.XRAY.NODE_HEALTH_CHECK;

    export const ResponseSchema = z.object({
        response: z.object({
            isAlive: z.boolean(),
            xrayInternalStatusCached: z.boolean(),
            xrayVersion: z.string().nullable(),
            nodeVersion: z.string(),
            pluginSyncAckSupported: z.boolean().optional(),
            nativePortPlansSupported: z.boolean().optional(),
            profileGraphDeliverySupported: z.boolean().optional(),
            portPlanStateSupported: z.boolean().optional(),
            portPlanDeliverySupported: z.boolean().optional(),
            portPlanDeliveryCapability: z.literal('remnacust-port-plan-delivery-v2').optional(),
            portPlanDeliveryEpoch: z
                .string()
                .regex(/^(0|[1-9][0-9]{0,18})$/)
                .refine(
                    (value) =>
                        /^(0|[1-9][0-9]{0,18})$/.test(value) &&
                        BigInt(value) <= 9223372036854775807n,
                )
                .optional(),
        }),
    });

    export type Response = z.infer<typeof ResponseSchema>;
}
