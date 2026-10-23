export class GetNodeHealthCheckResponseModel {
    public isAlive: boolean;
    public xrayInternalStatusCached: boolean;
    public xrayVersion: null | string;
    public nodeVersion: string;
    public readonly pluginSyncAckSupported = true;
    public nativePortPlansSupported: boolean;
    public portPlanStateSupported = true;
    public portPlanDeliverySupported = true;
    public readonly portPlanDeliveryCapability = 'remnacust-port-plan-delivery-v2';
    constructor(
        isAlive: boolean,
        xrayInternalStatusCached: boolean,
        xrayVersion: null | string,
        nodeVersion: string,
        nativePortPlansSupported = false,
        public readonly portPlanDeliveryEpoch = '0',
        public readonly profileGraphDeliverySupported = false,
    ) {
        this.isAlive = isAlive;
        this.xrayInternalStatusCached = xrayInternalStatusCached;
        this.xrayVersion = xrayVersion;
        this.nodeVersion = nodeVersion;
        this.nativePortPlansSupported = nativePortPlansSupported;
    }
}
