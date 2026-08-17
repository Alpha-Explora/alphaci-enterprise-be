import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { AdminModule } from '../admin/admin.module';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { GithubInstallationsRepository } from './github-installations.repository';
import { GithubController } from './github.controller';
import { GithubTeamRoleService } from './github-team-role.service';
import { GithubWebhookController } from './github-webhook.controller';
import { GithubService } from './github.service';

@Module({
  // AdminModule supplies PlatformAdminsRepository (app_role reads/writes) and
  // does not import GithubModule, so there is no cycle.
  imports: [DatabaseModule, PersistenceModule, AdminModule, AuditModule],
  controllers: [GithubController, GithubWebhookController],
  providers: [
    GithubService,
    GithubTeamRoleService,
    GithubInstallationsRepository,
    SessionAuthGuard,
  ],
  exports: [GithubService, GithubTeamRoleService],
})
export class GithubModule {}
