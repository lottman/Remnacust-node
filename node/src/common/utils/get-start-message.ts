import prettyBytes from 'pretty-bytes';

import { INestApplication } from '@nestjs/common';

import { XrayService } from '../../modules/xray-core/xray.service';
import { getSystemInfo } from './get-system-stats';
import { renderBox } from './render-box';

export async function getStartMessage(appPort: number, app: INestApplication) {
    const xrayService = app.get(XrayService);

    const xrayInfo = xrayService.getXrayInfo();
    const systemInfo = getSystemInfo();

    return renderBox(`Remnacust Node v${__RWNODE_VERSION__}`, [
        'Docs → https://github.com/lottman/Remnacust-node\nSupport → https://t.me/lottman',
        `API Port: ${appPort}`,
        `XRay Core: v${xrayInfo.version || 'N/A'}\nXRay Path: ${xrayInfo.path}`,
        `${systemInfo.cpus}C, ${systemInfo.cpuModel}, ${prettyBytes(systemInfo.memoryTotal)}`,
        `Kernel: ${systemInfo.release} ${systemInfo.type} ${systemInfo.platform}`,
        `Network Interfaces: ${systemInfo.networkInterfaces.join(', ')}`,
    ]);
}
