import { Module } from '@nestjs/common';

import { DevOnlyGuard } from '../../common/guards/dev-only.guard';
import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { PersistenceModule } from '../persistence/persistence.module';
import { SubscriptionModule } from '../subscription/subscription.module';
import { ProjectsModule } from '../projects/projects.module';
import { AdminModule } from '../admin/admin.module';
import { GithubModule } from '../github/github.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  imports: [
    SubscriptionModule,
    PersistenceModule,
    ProjectsModule,
    AdminModule,
    // GithubTeamRoleService — derives app_role from GitHub org teams at login.
    GithubModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, DevOnlyGuard, SessionAuthGuard],
  exports: [AuthService],
})
export class AuthModule {}
