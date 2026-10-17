import { z } from 'zod';

const counterPattern = /^[1-9][0-9]{0,18}$/;
export const PortPlanCounterSchema = z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/)
    .refine((value) => counterPattern.test(value) && BigInt(value) <= 9223372036854775807n);
export const PortPlanDeliverySchema = z.object({
    epoch: PortPlanCounterSchema,
    owner: z.uuid(),
});
export const PortPlanTargetSchema = z.object({
    revision: PortPlanCounterSchema,
    enabled: z.boolean(),
    delivery: PortPlanDeliverySchema.optional(),
});
