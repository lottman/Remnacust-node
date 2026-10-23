/** Match authenticated panel identities, including device and host-scoped credentials. */
export function userIdentityOwner(identity: string): string | null {
    return /^([1-9][0-9]{0,18})(?:~[a-f0-9]{24}(?:~h[a-f0-9]{32})?)?$/.exec(identity)?.[1] ?? null;
}
