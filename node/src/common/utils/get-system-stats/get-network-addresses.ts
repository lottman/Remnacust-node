import os from 'node:os';

import type { GetNetworkAddressesCommand } from '@libs/contracts/commands';
import { AssignedUnicastAddressSchema, MAX_NETWORK_ADDRESSES } from '@libs/contracts/models';

const virtualInterface =
    /^(?:docker|veth|br(?:idge|[-\d]|$)|virbr|lxcbr|lxdbr|podman|vnet|tun|tap|utun|wg|wireguard|wintun|tailscale|zerotier|zt|cni|flannel|cali|kube|vxlan|geneve|dummy|ifb|sit(?:\d|$)|ip6tnl|ipip|gre(?:tap|[-\d]|$)|ip6gre|ppp|vpn|ipsec|vEthernet|vboxnet|vmnet|vmware|virtualbox|vether)/i;

function isLocalAddress(address: string): boolean {
    if (!address.includes(':')) {
        const [first, second] = address.split('.').map(Number);
        return (
            first === 10 ||
            (first === 172 && second >= 16 && second <= 31) ||
            (first === 192 && second === 168) ||
            (first === 100 && second >= 64 && second <= 127) ||
            (first === 198 && (second === 18 || second === 19))
        );
    }

    const first = parseInt(address.split(':')[0], 16);
    return first >= 0xfc00 && first <= 0xfdff;
}

export function getNetworkAddresses(
    interfaces = os.networkInterfaces(),
): GetNetworkAddressesCommand.Response['response'] {
    const addresses = new Set<string>();
    for (const [name, entries] of Object.entries(interfaces)) {
        for (const entry of entries ?? []) {
            if (entry.internal !== false) continue;
            const result = AssignedUnicastAddressSchema.safeParse(entry.address);
            if (!result.success || entry.family !== (entry.address.includes(':') ? 'IPv6' : 'IPv4'))
                continue;
            const address = result.data;
            if (isLocalAddress(address) && virtualInterface.test(name)) continue;
            addresses.add(address);
            if (addresses.size > MAX_NETWORK_ADDRESSES)
                throw new Error('Node network address inventory exceeds the supported limit');
        }
    }
    return { addresses: [...addresses].sort(), complete: true };
}
