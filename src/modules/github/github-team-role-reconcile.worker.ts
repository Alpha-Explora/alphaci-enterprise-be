import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../config/app.config';
import { DatabaseService } from '../database/database.service';
import { GithubTeamRoleService } from './github-team-role.service';

/**
 * Periodically re-reads the GitHub org team rosters and corrects any app_role
 * that drifted (Phase 4b).
 *
 * The `membership` webhook is the fast path — this is the backstop for
 * deliveries that were missed, dropped, or arrived while the service was down.
 * Polling matches the codebase's existing style (GithubSyncOutboxWorker); there
 * is no message broker to schedule against.
 *
 * Inert unless GITHUB_TEAM_ROLE_SYNC=enforce AND the interval is > 0.
 */
@Injectable()
export class GithubTeamRoleReconcileWorker
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(GithubTeamRoleReconcileWorker.name);
  private intervalHandle: ReturnType<typeof setInterval> | undefined;
  /** Guards against a slow sweep overlapping the next tick. */
  private running = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly databaseService: DatabaseService,
    private readonly githubTeamRoleService: GithubTeamRoleService,
  ) {}

  onModuleInit(): void {
    const config = this.configService.getOrThrow<AppConfig>('app');
    const intervalMs = config.github.teamRoleReconcileIntervalMs;

    if (
      config.github.teamRoleSync !== 'enforce' ||
      !Number.isFinite(intervalMs) ||
      intervalMs <= 0 ||
      !this.databaseService.isEnabled()
    ) {
      return;
    }

    this.logger.log(
      `GitHub team role reconciliation every ${String(intervalMs)}ms.`,
    );

    // Catching at the scheduling boundary, for the same reason
    // GithubSyncOutboxWorker does: sweep() can reject before its own handler is
    // reached (a connect-level DB failure rejects the promise itself), and an
    // unawaited rejection is fatal under Node's default policy — turning a
    // transient outage into a process exit and a restart loop.
    this.intervalHandle = setInterval(() => {
      this.sweep().catch((error: unknown) => {
        this.logger.error(
          `Role reconciliation sweep failed: ${
            error instanceof Error ? error.message : JSON.stringify(error)
          }`,
        );
      });
    }, intervalMs);
  }

  onModuleDestroy(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
    }
  }

  /** Exposed so tests and any manual trigger can run one pass synchronously. */
  async sweep(): Promise<void> {
    if (this.running) {
      this.logger.debug('Skipping sweep — the previous one is still running.');
      return;
    }
    this.running = true;
    try {
      await this.githubTeamRoleService.reconcileAll();
    } finally {
      this.running = false;
    }
  }
}
