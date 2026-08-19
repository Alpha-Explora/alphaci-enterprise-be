import { Module } from '@nestjs/common';

import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { SubscriptionGuard } from '../../common/guards/subscription.guard';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { GithubModule } from '../github/github.module';
import { NotificationsModule } from '../notifications/index.js';
import { PersistenceModule } from '../persistence/persistence.module';
import { ProjectsRepository } from '../projects/projects.repository';
import { SubscriptionModule } from '../subscription/subscription.module';
import { UsageModule } from '../usage/usage.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { DeploymentTargetsController } from './deployment-targets.controller';
import { DeploymentTargetsRepository } from './deployment-targets.repository';
import { DeploymentTargetsService } from './deployment-targets.service';
import { DeploymentStrategyResolver } from './deployment-strategy.resolver';
import { EnvTokenEncryptionService } from './encryption.service';
import { EnvFeatureGuard } from './env-feature.guard';
import { EnvVarsController } from './env-vars.controller';
import { EnvVarsRepository } from './env-vars.repository';
import { EnvVarsService } from './env-vars.service';
import { ProviderClientRegistry } from './provider-clients/provider-client.registry';
import { ProjectDeploymentProvisioningService } from './project-deployment-provisioning.service';
import { RenderCiSecretsService } from './render-ci-secrets.service';
import { RenderCostPolicyService } from './render-cost-policy.service';
import { RenderEnvClient } from './provider-clients/render-env.client';
import { VercelEnvClient } from './provider-clients/vercel-env.client';
import { ProviderConnectionsController } from './provider-connections.controller';
import { ProviderConnectionsRepository } from './provider-connections.repository';
import { ProviderConnectionsService } from './provider-connections.service';
import { VercelCiSecretsService } from './vercel-ci-secrets.service';

@Module({
  imports: [
    AuditModule,
    DatabaseModule,
    GithubModule,
    NotificationsModule,
    PersistenceModule,
    SubscriptionModule,
    UsageModule,
    WorkspacesModule,
  ],
  controllers: [
    ProviderConnectionsController,
    DeploymentTargetsController,
    EnvVarsController,
  ],
  providers: [
    ProjectsRepository,
    ProviderConnectionsRepository,
    DeploymentTargetsRepository,
    EnvVarsRepository,
    ProviderConnectionsService,
    DeploymentTargetsService,
    DeploymentStrategyResolver,
    EnvVarsService,
    EnvTokenEncryptionService,
    RenderEnvClient,
    VercelEnvClient,
    ProviderClientRegistry,
    ProjectDeploymentProvisioningService,
    RenderCiSecretsService,
    RenderCostPolicyService,
    VercelCiSecretsService,
    EnvFeatureGuard,
    SessionAuthGuard,
    SubscriptionGuard,
  ],
  exports: [
    ProjectDeploymentProvisioningService,
    DeploymentTargetsRepository,
    EnvVarsRepository,
    ProviderConnectionsRepository,
    EnvTokenEncryptionService,
    ProviderClientRegistry,
  ],
})
export class EnvProvisioningModule {}
