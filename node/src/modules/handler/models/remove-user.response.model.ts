export class RemoveUserResponseModel {
    success: boolean;
    error: null | string;
    deviceRevocationSupported: boolean;

    constructor(success: boolean, error: null | string) {
        this.success = success;
        this.error = error;
        this.deviceRevocationSupported = process.env.XERA_DEVICE_REVOKE === 'true';
    }
}
