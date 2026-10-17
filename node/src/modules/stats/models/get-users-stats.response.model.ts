import { IUserStat } from './interfaces';

export class GetUsersStatsResponseModel {
    public users: IUserStat[];
    public coreProcessId: string | null;

    constructor(users: IUserStat[], coreProcessId: string | null = null) {
        this.users = users;
        this.coreProcessId = coreProcessId;
    }
}
