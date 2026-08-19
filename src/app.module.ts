import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { appConfig } from './config/app.config.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { validateEnv } from './common/config/env.validation.js';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware.js';
import { HealthModule } from './health/health.module.js';
import { SupabaseModule } from './supabase/supabase.module.js';

// Ported Modules
import { AuthModule } from './modules/auth/auth.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { GithubModule } from './modules/github/github.module.js';
import { SubscriptionModule } from './modules/subscription/subscription.module.js';
import { WorkflowsModule } from './modules/workflows/workflows.module.js';
import { ProjectsModule } from './modules/projects/projects.module.js';
import { CiModule } from './modules/ci/ci.module.js';
import { ExistingReposModule } from './modules/existing-repos/existing-repos.module.js';
import { CapabilitiesModule } from './modules/capabilities/capabilities.module.js';
import { EnvProvisioningModule } from './modules/env-provisioning/env-provisioning.module.js';
import { UsageModule } from './modules/usage/usage.module.js';
import { WorkspacesModule } from './modules/workspaces/workspaces.module.js';
import { NotificationsModule } from './modules/notifications/index.js';
import { FeedbackModule } from './modules/feedback/feedback.module.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { HierarchyModule } from './modules/hierarchy/hierarchy.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      cache: true,
      load: [appConfig],
      // validateEnv runs unconditionally in all environments so that
      // missing/malformed secrets cause a hard crash at startup rather than
      // silently degrading to insecure fallbacks during local development.
      validate: validateEnv,
    }),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 60 }]),
    SupabaseModule,
    HealthModule,

    // Business modules
    AuthModule,
    CatalogModule,
    GithubModule,
    SubscriptionModule,
    CiModule,
    WorkflowsModule,
    ProjectsModule,
    ExistingReposModule,
    CapabilitiesModule,
    EnvProvisioningModule,
    UsageModule,
    WorkspacesModule,
    NotificationsModule,
    FeedbackModule,
    AdminModule,
    HierarchyModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
