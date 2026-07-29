import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../../config/app.config';
import { DatabaseService } from '../../database/database.service';
import {
  GithubSyncService,
  type HierarchyOutboxJobPayload,
} from './github-sync.service';

const BATCH_SIZE = 20;

interface OutboxRow {
  id: string;
  topic: string;
  payload: HierarchyOutboxJobPayload | string;
}

/**
 * Polling loop over outbox_events (topic prefix
 * `hierarchy.repository_assignment.`) — matches this codebase's existing
 * style (no message broker present, plan §1.7). Runs regardless of
 * HIERARCHY_GITHUB_SYNC_MODE — the mode only changes which
 * GithubTeamAccessProvider is injected into GithubSyncService (stub vs
 * live), not whether the outbox is drained.
 */
@Injectable()
export class GithubSyncOutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GithubSyncOutboxWorker.name);
  private intervalHandle: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly githubSyncService: GithubSyncService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit(): void {
    const config = this.configService.getOrThrow<AppConfig>('app');
    if (!config.hierarchy.enabled || !this.databaseService.isEnabled()) {
      return;
    }
    // poll() can reject before its own try/catch is ever reached: withClient
    // acquires the pool client *outside* that callback, so a connect-level
    // failure (ENETUNREACH when the DB host is unreachable, ECONNREFUSED, a
    // dead pool) rejects poll() itself. `void` marks the promise as
    // intentionally unawaited but attaches no rejection handler, so such a
    // failure becomes an unhandled rejection — fatal under Node's default
    // policy. That turned a transient DB outage into a process exit and a
    // Render crash-loop. Catching at the scheduling boundary is the only place
    // that contains both this and a failing ROLLBACK inside poll()'s handler.
    this.intervalHandle = setInterval(() => {
      this.poll().catch((error: unknown) => {
        this.logger.error(
          `Hierarchy outbox poll failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }, config.hierarchy.syncPollIntervalMs);
  }

  onModuleDestroy(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
    }
  }

  /** Exposed for tests and the manual-trigger reconcile path to drain synchronously. */
  async poll(): Promise<void> {
    await this.databaseService.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        const { rows } = await client.query<OutboxRow>(
          `
            SELECT id, topic, payload
            FROM outbox_events
            WHERE status = 'pending'
              AND topic LIKE 'hierarchy.repository_assignment.%'
              AND topic != 'hierarchy.repository_assignment.reconcile'
            ORDER BY created_at ASC
            LIMIT $1
            FOR UPDATE SKIP LOCKED;
          `,
          [BATCH_SIZE],
        );

        for (const row of rows) {
          const payload: HierarchyOutboxJobPayload =
            typeof row.payload === 'string'
              ? (JSON.parse(row.payload) as HierarchyOutboxJobPayload)
              : row.payload;

          try {
            await this.githubSyncService.processJob(row.topic, payload);
            await client.query(
              `UPDATE outbox_events SET status = 'published', processed_at = NOW() WHERE id = $1;`,
              [row.id],
            );
          } catch (error) {
            this.logger.error(
              `Unexpected error processing hierarchy outbox job ${row.id}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            await client.query(
              `UPDATE outbox_events SET status = 'failed', processed_at = NOW() WHERE id = $1;`,
              [row.id],
            );
          }
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        this.logger.error(
          `Hierarchy outbox poll failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });
  }
}
