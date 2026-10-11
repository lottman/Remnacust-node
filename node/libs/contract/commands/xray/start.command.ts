import { z } from 'zod';

import { REST_API } from '../../api';
import { NodeMetadataSchema, NodeSystemSchema } from '../../models';

export namespace StartXrayCommand {
    export const url = REST_API.XRAY.START;
    export const RequestSchema = z.object({
        internals: z.object({
            reconciliation: z
                .object({
                    url: z
                        .url()
                        .max(2048)
                        .refine((value) => {
                            const url = new URL(value);
                            return (
                                url.protocol === 'https:' &&
                                !url.username &&
                                !url.password &&
                                !url.search &&
                                !url.hash &&
                                /^\/api\/nodes\/[a-f0-9-]{36}\/reconcile$/.test(url.pathname)
                            );
                        }),
                    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
                    revision: z
                        .string()
                        .regex(/^\d{1,20}$/)
                        .default('0'),
                })
                .optional(),
            metadata: NodeMetadataSchema.optional(),
            integrations: z.record(z.string(), z.unknown()).optional(),
            forceRestart: z.boolean().default(false),
            hashes: z.object({
                emptyConfig: z.string(),
                inbounds: z.array(
                    z.object({
                        usersCount: z.number(),
                        hash: z.string(),
                        tag: z.string(),
                    }),
                ),
            }),
        }),
        xrayConfig: z.record(z.string(), z.unknown()),
    });

    export type Request = z.infer<typeof RequestSchema>;

    export const ResponseSchema = z.object({
        response: z.object({
            isStarted: z.boolean(),
            version: z.string().nullable(),
            error: z.string().nullable(),
            nodeInformation: z.object({
                version: z.string().nullable(),
            }),
            system: NodeSystemSchema,
        }),
    });

    export type Response = z.infer<typeof ResponseSchema>;
}
