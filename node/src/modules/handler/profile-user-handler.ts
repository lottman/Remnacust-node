import { BinaryWriter } from '@bufbuild/protobuf/wire';
import { createClient, Metadata } from 'nice-grpc';

import { XtlsApi } from '@remnawave/xtls-sdk';
import createTypedMessage from '@remnawave/xtls-sdk/build/src/common/utils/create-typed-message/create-typed-message';
import {
    AddUserResponseModel,
    RemoveUserResponseModel,
} from '@remnawave/xtls-sdk/build/src/handler/models';
import {
    AddUserOperation,
    RemoveUserOperation,
    HandlerServiceDefinition,
    type HandlerServiceClient,
} from '@remnawave/xtls-sdk/build/src/xray-protos/app/proxyman/command/command';
import { User } from '@remnawave/xtls-sdk/build/src/xray-protos/common/protocol/user';
import { Account as HysteriaAccount } from '@remnawave/xtls-sdk/build/src/xray-protos/proxy/hysteria/account/config';
import { Account as ShadowsocksAccount } from '@remnawave/xtls-sdk/build/src/xray-protos/proxy/shadowsocks/config';
import { Account as Shadowsocks2022Account } from '@remnawave/xtls-sdk/build/src/xray-protos/proxy/shadowsocks_2022/config';
import { Account as TrojanAccount } from '@remnawave/xtls-sdk/build/src/xray-protos/proxy/trojan/config';
import { Account as VlessAccount } from '@remnawave/xtls-sdk/build/src/xray-protos/proxy/vless/account';

import { coreRpcSignal } from '../xray-core/core-rpc-deadline';

type Handler = XtlsApi['handler'];
type Input<K extends keyof Handler> = Handler[K] extends (data: infer T) => unknown ? T : never;
const bindingUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** Uses the existing private SDK channel; each call owns its metadata and deadline. */
export class ProfileUserHandler {
    private rpcClient?: HandlerServiceClient;
    constructor(
        private readonly api: XtlsApi,
        private readonly bindingsForTag: (tag: string) => readonly string[],
    ) {}

    private get client() {
        return (this.rpcClient ??= createClient(HandlerServiceDefinition, this.api.channel));
    }

    private bindings(tag: string): string[] {
        const bindings = [...new Set(this.bindingsForTag(tag))];
        if (bindings.length > 512 || bindings.some((value) => !bindingUuid.test(value)))
            throw new Error('Invalid local profile binding index');
        return bindings;
    }

    private options(binding: string, signal: AbortSignal) {
        signal.throwIfAborted();
        return {
            metadata: Metadata(binding ? { 'x-remnacust-profile-binding': binding } : {}),
            signal,
        };
    }

    private async add(
        tag: string,
        username: string,
        level: number,
        account: User['account'],
    ): ReturnType<Handler['addVlessUser']> {
        try {
            const bindings = this.bindings(tag);
            const operation = createTypedMessage(AddUserOperation, {
                user: User.create({ email: username, level, account }),
            });
            const signal = coreRpcSignal();
            for (const binding of bindings.length ? bindings : ['']) {
                signal.throwIfAborted();
                const options = this.options(binding, signal);
                try {
                    await this.client.alterInbound({ tag, operation }, options);
                } catch (error) {
                    if (!binding) {
                        if (
                            !signal.aborted &&
                            error instanceof Error &&
                            error.message.includes('already exists')
                        )
                            return { isOk: true, data: new AddUserResponseModel(false) };
                        throw error;
                    }
                    // A previous binding may have committed before a later one
                    // failed. Retry only accepts the exact stored credential.
                    signal.throwIfAborted();
                    const stored = await this.client.getInboundUsers({ tag }, options);
                    const user = stored.users.find((value) => value.email === username);
                    if (
                        !account ||
                        !user?.account ||
                        user.level !== level ||
                        user.account.type !== account.type ||
                        !Buffer.from(user.account.value).equals(Buffer.from(account.value))
                    )
                        throw error;
                }
            }
            return { isOk: true, data: new AddUserResponseModel(true) };
        } catch (error) {
            return {
                isOk: false,
                message: error instanceof Error ? error.message : 'Profile user update failed',
            };
        }
    }

    async removeUser(tag: string, username: string): ReturnType<Handler['removeUser']> {
        try {
            const bindings = this.bindings(tag);
            const operation = createTypedMessage(RemoveUserOperation, { email: username });
            const signal = coreRpcSignal();
            for (const binding of bindings.length ? bindings : ['']) {
                signal.throwIfAborted();
                try {
                    await this.client.alterInbound(
                        { tag, operation },
                        this.options(binding, signal),
                    );
                } catch (error) {
                    if (
                        !binding &&
                        !signal.aborted &&
                        error instanceof Error &&
                        error.message.includes('not found')
                    )
                        return { isOk: true, data: new RemoveUserResponseModel(false) };
                    throw error;
                }
            }
            return { isOk: true, data: new RemoveUserResponseModel(true) };
        } catch (error) {
            return {
                isOk: false,
                message: error instanceof Error ? error.message : 'Profile user removal failed',
            };
        }
    }

    async removeRetiredUser(username: string): ReturnType<Handler['removeUser']> {
        try {
            await this.client.alterInbound(
                {
                    tag: '',
                    operation: createTypedMessage(RemoveUserOperation, { email: username }),
                },
                {
                    metadata: Metadata({ 'x-remnacust-retired-user-removal': '1' }),
                    signal: coreRpcSignal(),
                },
            );
            return { isOk: true, data: new RemoveUserResponseModel(true) };
        } catch (error) {
            return {
                isOk: false,
                message: error instanceof Error ? error.message : 'Retired user removal failed',
            };
        }
    }

    addVlessUser(data: Input<'addVlessUser'>) {
        return this.add(
            data.tag,
            data.username,
            data.level,
            createTypedMessage(VlessAccount, {
                id: data.uuid,
                flow: data.flow,
                encryption: 'none',
            }),
        );
    }

    addTrojanUser(data: Input<'addTrojanUser'>) {
        return this.add(
            data.tag,
            data.username,
            data.level,
            createTypedMessage(TrojanAccount, { password: data.password }),
        );
    }

    addShadowsocksUser(data: Input<'addShadowsocksUser'>) {
        return this.add(
            data.tag,
            data.username,
            data.level,
            createTypedMessage(ShadowsocksAccount, {
                password: data.password,
                cipherType: data.cipherType,
                ivCheck: data.ivCheck,
            }),
        );
    }

    addShadowsocks2022User(data: Input<'addShadowsocks2022User'>) {
        return this.add(
            data.tag,
            data.username,
            data.level,
            createTypedMessage(Shadowsocks2022Account, { key: data.key }),
        );
    }

    addHysteriaUser(data: Input<'addHysteriaUser'>) {
        return this.add(
            data.tag,
            data.username,
            data.level,
            createTypedMessage(HysteriaAccount, { auth: data.uuid }),
        );
    }

    addMasqueUser(data: { tag: string; username: string; password: string }) {
        return this.add(data.tag, data.username, 0, {
            $type: 'xray.common.serial.TypedMessage',
            type: 'xray.proxy.masque.Account',
            value: new BinaryWriter().uint32(10).string(data.password).finish(),
        });
    }
}
