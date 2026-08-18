import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import type { AppConfig } from '../../config/app.config';
import { AdminModule } from '../admin/admin.module';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { GithubModule } from '../github/github.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { ProjectsRepository } from '../projects/projects.repository';

import { AssignmentsController } from './assignments/assignments.controller';
import { AssignmentsRepository } from './assignments/assignments.repository';
import { AssignmentsService } from './assignments/assignments.service';
import { RepoConfigBrokerController } from './config-broker/repo-config-broker.controller';
import { RepoConfigBrokerService } from './config-broker/repo-config-broker.service';
import { RepoConfigurationChangesRepository } from './config-broker/repo-configuration-changes.repository';
import { GithubSecretsProvider } from './config-broker/providers/github-secrets.provider';
import { DeliveryProjectsController } from './delivery-projects/delivery-projects.controller';
import { DeliveryProjectsRepository } from './delivery-projects/delivery-projects.repository';
import { DeliveryProjectsService } from './delivery-projects/delivery-projects.service';
import { GithubSyncOutboxWorker } from './github-sync/github-sync-outbox.worker';
import { GithubAccessSyncRepository } from './github-sync/github-access-sync.repository';
import { GithubSyncService } from './github-sync/github-sync.service';
import { GithubTeamAccessProvider } from './github-sync/providers/github-team-access.provider';
import { GithubTeamAccessLiveProvider } from './github-sync/providers/github-team-access.live';
import { GithubTeamAccessStubProvider } from './github-sync/providers/github-team-access.stub';
import { GroupActivityRepository } from './group-activity.repository';
import { GroupActivityService } from './group-activity.service';
import { GroupMembersService } from './groups/group-members.service';
import { GroupsController } from './groups/groups.controller';
import { GroupsRepository } from './groups/groups.repository';
import { GroupsService } from './groups/groups.service';
import { HierarchyAccessService } from './hierarchy-access.service';
import { MeController } from './me.controller';
import { RepositoriesController } from './repositories/repositories.controller';
import { RepositoriesRepository } from './repositories/repositories.repository';
import { RepositoriesService } from './repositories/repositories.service';
import { SystemsController } from './systems/systems.controller';
import { SystemsRepository } from './systems/systems.repository';
import { SystemsService } from './systems/systems.service';

@Module({
  imports: [
    DatabaseModule,
    PersistenceModule, // UsersRepository, OutboxRepository (needed by SessionAuthGuard + GithubSyncService)
    AuditModule,
    GithubModule, // GithubService (repo creation, installation tokens, Actions secrets)
    AdminModule, // PlatformAdminsRepository, PlatformAdminGuard (global-role overrides, transfer endpoint)
  ],
  controllers: [
    GroupsController,
    SystemsController,
    DeliveryProjectsController,
    RepositoriesController,
    AssignmentsController,
    RepoConfigBrokerController,
    MeController,
  ],
  providers: [
    SessionAuthGuard,
    // ProjectsRepository is registered directly here (not via ProjectsModule,
    // which exports nothing) — same pattern already used by
    // env-provisioning.module.ts for the same class.
    ProjectsRepository,
    HierarchyAccessService,
    GroupsRepository,
    GroupsService,
    GroupMembersService,
    GroupActivityRepository,
    GroupActivityService,
    SystemsRepository,
    SystemsService,
    DeliveryProjectsRepository,
    DeliveryProjectsService,
    RepositoriesRepository,
    RepositoriesService,
    AssignmentsRepository,
    AssignmentsService,
    GithubAccessSyncRepository,
    GithubSyncService,
    GithubSyncOutboxWorker,
    GithubTeamAccessStubProvider,
    GithubTeamAccessLiveProvider,
    {
      provide: GithubTeamAccessProvider,
      useFactory: (
        configService: ConfigService,
        stub: GithubTeamAccessStubProvider,
        live: GithubTeamAccessLiveProvider,
      ) => {
        const config = configService.getOrThrow<AppConfig>('app');
        return config.hierarchy.githubSyncMode === 'live' ? live : stub;
      },
      inject: [
        ConfigService,
        GithubTeamAccessStubProvider,
        GithubTeamAccessLiveProvider,
      ],
    },
    RepoConfigurationChangesRepository,
    GithubSecretsProvider,
    RepoConfigBrokerService,
  ],
})
export class HierarchyModule {}
