import { hasCapNetAdmin } from 'sockdestroy';

import { XRAY_INTERNAL_FULL_WEBHOOK_PATH } from '@libs/contracts/constants';
import {
    XRAY_API_INBOUND_MODEL,
    XRAY_DEFAULT_API_MODEL,
    XRAY_DEFAULT_POLICY_MODEL,
    XRAY_DEFAULT_STATS_MODEL,
    XRAY_ROUTING_RULES_MODEL,
    XRAY_TORRENT_BLOCKER_OUTBOUND_MODEL,
    XRAY_TORRENT_BLOCKER_ROUTING_RULES_MODEL,
} from '@libs/contracts/constants/xray';

import { IPolicyConfig } from './interfaces';

interface IRoutingXrayConfig {
    rules: {
        ruleTag?: string;
        webhook?: {
            url: string;
            deduplication: number;
        };
        [key: string]: unknown;
    }[];
}

interface IGenerateApiConfigParams {
    control?: boolean;
    config: Record<string, unknown>;
    torrentBlockerState: {
        enabled: boolean;
        includeRuleTags: Set<string>;
        rulePosition: number;
    };
    internal: {
        socketPath: string;
        token: string;
        xtlsApiSocketPath: string;
    };
}

export const generateApiConfig = (args: IGenerateApiConfigParams): Record<string, unknown> => {
    const { config, torrentBlockerState, internal, control = true } = args;
    const routingConfig = config.routing as Record<string, unknown> | undefined;
    const usesRoutingScript =
        typeof routingConfig?.script === 'string' && routingConfig.script.length > 0;
    if (usesRoutingScript && torrentBlockerState.enabled)
        throw new Error(
            'Lua routing cannot use the rules-based Torrent Blocker. Disable the plugin or implement blocking in the routing script.',
        );

    const policyConfig = config.policy as undefined | IPolicyConfig;
    const hasCapNetAdminResult = hasCapNetAdmin();

    const builtPolicy: IPolicyConfig = {
        levels: Object.fromEntries(
            Object.entries({ '0': {}, ...policyConfig?.levels }).map(([level, settings]) => [
                level,
                {
                    ...settings,
                    statsUserUplink: XRAY_DEFAULT_POLICY_MODEL.policy.levels['0'].statsUserUplink,
                    statsUserDownlink:
                        XRAY_DEFAULT_POLICY_MODEL.policy.levels['0'].statsUserDownlink,
                    statsUserOnline: hasCapNetAdminResult,
                },
            ]),
        ),
        system: XRAY_DEFAULT_POLICY_MODEL.policy.system,
    };

    const result = {
        ...config,
        ...XRAY_DEFAULT_STATS_MODEL,
        // A direct private API listener does not need to modify Lua routing.
        // Keep the existing tunnel/rule for ordinary profiles and old cores.
        api: control ? {
            ...XRAY_DEFAULT_API_MODEL.api,
            ...(usesRoutingScript ? { listen: `${internal.xtlsApiSocketPath},0600` } : {}),
        } : config.api,
        inbounds: [
            ...(!control || usesRoutingScript
                ? []
                : [XRAY_API_INBOUND_MODEL({ xtlsApiSocketPath: internal.xtlsApiSocketPath })]),
            ...(Array.isArray(config.inbounds) ? config.inbounds : []),
        ],
        outbounds: [...(Array.isArray(config.outbounds) ? config.outbounds : [])],
        policy: builtPolicy,
        routing: usesRoutingScript
            ? { ...routingConfig }
            : {
                  ...routingConfig,
                  rules: [
                      ...(control ? [XRAY_ROUTING_RULES_MODEL] : []),
                      ...((config.routing as unknown as IRoutingXrayConfig)?.rules ?? []).filter(
                          (rule) => !control || rule.outboundTag !== 'REMNAWAVE_API',
                      ),
                  ],
              },
    };

    if (torrentBlockerState.enabled) {
        const webhookUrl = buildWebhookUrl(internal);
        const routing = result.routing as IRoutingXrayConfig;

        result.outbounds.push(XRAY_TORRENT_BLOCKER_OUTBOUND_MODEL);

        routing.rules.splice(
            resolveRuleIndex(torrentBlockerState.rulePosition, routing.rules.length, control),
            0,
            XRAY_TORRENT_BLOCKER_ROUTING_RULES_MODEL({ webhookUrl }),
        );

        if (torrentBlockerState.includeRuleTags.size > 0) {
            for (const rule of routing.rules) {
                if (
                    rule.ruleTag &&
                    typeof rule.ruleTag === 'string' &&
                    torrentBlockerState.includeRuleTags.has(rule.ruleTag)
                ) {
                    rule.webhook = {
                        url: webhookUrl,
                        deduplication: 5,
                    };
                }
            }
        }
    }

    return result;
};

const resolveRuleIndex = (position: number, rulesLength: number, control: boolean): number => {
    const offset = control ? 1 : 0;
    const userRulesCount = rulesLength - offset;

    if (!Number.isInteger(position) || position <= 0) {
        return offset;
    }

    return offset + Math.min(position, userRulesCount);
};

const buildWebhookUrl = (internal: { socketPath: string; token: string }): string => {
    return `@${internal.socketPath}:${XRAY_INTERNAL_FULL_WEBHOOK_PATH}?token=${internal.token}`;
};
