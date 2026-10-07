import { BinaryWriter } from '@bufbuild/protobuf/wire';
import { createClient } from 'nice-grpc';
import { XtlsApi } from '@remnawave/xtls-sdk';
import { ISdkResponse } from '@remnawave/xtls-sdk/build/src/common/types';
import createTypedMessage from '@remnawave/xtls-sdk/build/src/common/utils/create-typed-message/create-typed-message';
import { AddUserResponseModel } from '@remnawave/xtls-sdk/build/src/handler/models';
import { AddUserOperation, HandlerServiceDefinition } from '@remnawave/xtls-sdk/build/src/xray-protos/app/proxyman/command/command';
import { User } from '@remnawave/xtls-sdk/build/src/xray-protos/common/protocol/user';

// Account.password is field 1 in the pinned Xray proxy/masque/config.proto.
// Use the existing authenticated local gRPC channel; no additional public endpoint.
export async function addMasqueUser(
    api: XtlsApi,
    data: { tag: string; username: string; password: string },
): Promise<ISdkResponse<AddUserResponseModel>> {
    try {
        await createClient(HandlerServiceDefinition, api.channel).alterInbound({
            tag: data.tag,
            operation: createTypedMessage(AddUserOperation, {
                user: User.create({
                    email: data.username,
                    level: 0,
                    account: {
                        type: 'xray.proxy.masque.Account',
                        value: new BinaryWriter().uint32(10).string(data.password).finish(),
                    },
                }),
            }),
        });
        return { isOk: true, data: new AddUserResponseModel(true) };
    } catch (error) {
        return { isOk: false, message: error instanceof Error ? error.message : 'MASQUE user update failed' };
    }
}
