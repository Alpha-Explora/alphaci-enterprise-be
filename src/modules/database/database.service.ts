import {
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from 'pg';

import type { AppConfig } from '../../config/app.config';
import { postgresSslConfig } from './postgres-ssl.config.js';

const SERVICE_SCHEMA_SEARCH_PATH = [
  'identity',
  'billing',
  'github_app',
  'projects',
  'platform',
  'workflow',
  'ci',
  'env_provisioning',
  'public',
].join(',');

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly config: AppConfig;
  private readonly pool: Pool | null;

  constructor(private readonly configService: ConfigService) {
    this.config = this.configService.getOrThrow<AppConfig>('app');

    if (!this.config.supabase.dbUrl) {
      this.pool = null;
      this.logger.warn(
        'SUPABASE_DB_URL is missing. Database-backed features are disabled.',
      );
      return;
    }

    this.logConnectionFingerprint(this.config.supabase.dbUrl);

    const sslConfig = postgresSslConfig(
      this.config.supabase.dbUrl,
      this.config.supabase.dbCaCert,
    );

    // Make the TLS posture visible at boot. The "verify against system CA
    // bundle" mode is the fragile one: it only works if Supabase's cert chain
    // is in Node's default bundle. If a future connection starts failing with a
    // TLS error (e.g. UNABLE_TO_VERIFY_LEAF_SIGNATURE), this log line tells you
    // the pool was verifying without a pinned CA — set SUPABASE_DB_CA_CERT.
    const sslMode =
      sslConfig === false
        ? 'disabled (local database)'
        : typeof sslConfig === 'object'
          ? 'verify with pinned CA (SUPABASE_DB_CA_CERT)'
          : 'verify against system CA bundle (no SUPABASE_DB_CA_CERT set)';
    this.logger.log(`Postgres pool initialising; TLS mode: ${sslMode}`);

    this.pool = new Pool({
      connectionString: this.config.supabase.dbUrl,
      ssl: sslConfig,
      // Connection budget: Supabase's Supavisor pooler runs this project in
      // session mode with pool_size: 15 (project-wide, shared by every
      // process that connects — see EMAXCONNSESSION incident 2026-07-13).
      // Three separate `pg.Pool`s dial this same pool_size: this one, the
      // connect-pg-simple session-store pool in main.ts (max: 2), and the
      // process-outbox cron job (max: 3, runs as its own process every
      // minute). The repo has no render.yaml / IaC exposing the web
      // service's instance count, so this is sized conservatively assuming
      // up to 2 concurrent web instances (Render can briefly run old+new
      // instances during a rolling deploy even without autoscaling
      // enabled): 2 instances x (this pool's max=3 + session pool's max=2)
      // + outbox's max=3 = 13, leaving 2 connections of headroom under the
      // pool_size: 15 ceiling for the deploy window/admin connections, and
      // 8 of 15 free in the (likely) single-instance steady state. If
      // Render's actual instance count is confirmed higher, or this pool is
      // starved under load, prefer raising the Supabase project's
      // pool_size (plan upgrade) over raising `max` here.
      max: 3,
      connectionTimeoutMillis: 10_000,
      query_timeout: 10_000,
      statement_timeout: 10_000,
      idleTimeoutMillis: 30_000,
      // Keep idle TCP connections alive. Render → Supabase traffic crosses a
      // load balancer / NAT that silently drops idle sockets; without keepalive
      // the next query on a reaped connection throws "Connection terminated" /
      // ECONNRESET. This was the root cause of intermittent 500s on the OAuth
      // callback, whose first DB call (oauth_states lookup) was the first to hit
      // a stale connection.
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      options: `-c search_path=${SERVICE_SCHEMA_SEARCH_PATH}`,
    });

    // pg emits 'error' on IDLE clients when the server or network drops them
    // out from under the pool. Without a handler this error is unhandled and
    // can crash the Node process. We only need to log it — pg automatically
    // removes the dead client from the pool, and the next query acquires a
    // fresh connection.
    this.pool.on('error', (err) => {
      this.logger.warn(
        `Idle Postgres client error (connection dropped, will be replaced): ${err.message}`,
      );
    });
  }

  /**
   * Logs the STRUCTURE of the connection string at boot — host, port, user,
   * database, and password *length* — but never the password itself. A direct
   * Postgres connection validates the exact password bytes via SCRAM, so a
   * "password authentication failed" in one environment but not another means
   * the bytes differ even when the env values look identical. Comparing this
   * line across environments makes the real difference (a different password
   * length, an unexpected url-encoding, or an unparseable URL) obvious.
   */
  private logConnectionFingerprint(dbUrl: string): void {
    try {
      const u = new URL(dbUrl);
      const rawPwLen = u.password.length;
      const decodedPwLen = decodeURIComponent(u.password).length;
      this.logger.log(
        `Postgres target: host=${u.hostname} port=${u.port || '(default)'} ` +
          `user=${u.username} db=${u.pathname.replace(/^\//, '') || '(default)'} ` +
          `passwordLength=${decodedPwLen}` +
          (rawPwLen !== decodedPwLen ? ` (url-encoded; raw=${rawPwLen})` : ''),
      );
    } catch {
      this.logger.error(
        'SUPABASE_DB_URL is not a parseable connection URL. Check for stray ' +
          'whitespace, a missing scheme (postgres://), or unencoded special ' +
          'characters in the password.',
      );
    }
  }

  isEnabled(): boolean {
    return this.pool !== null;
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<T>> {
    const pool = this.getPoolOrThrow();

    try {
      return await pool.query<T>(text, values);
    } catch (error) {
      // A pooled connection can go stale between requests (idle reaped by the
      // Supabase pooler / network). The first query to use it throws a
      // connection-level error. pg has already discarded the bad client, so a
      // single retry transparently acquires a fresh connection. We retry only
      // for connection-level failures — never for query/constraint errors,
      // which would be wrong to re-run.
      if (this.isRetryableConnectionError(error)) {
        this.logger.warn(
          `Postgres query hit a stale connection; retrying once: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        try {
          return await pool.query<T>(text, values);
        } catch (retryError) {
          throw this.classifyDbError(retryError);
        }
      }
      throw this.classifyDbError(error);
    }
  }

  /**
   * Maps low-level pg failures to clearer, actionable errors. Infrastructure
   * failures — the DB rejecting our credentials, or being unreachable — become
   * a 503 (retryable, honest "infra is down") instead of an opaque 500 that
   * reads like an application crash. Genuine SQL errors (syntax, constraint,
   * etc.) are returned untouched so real bugs are never masked as 503s.
   */
  private classifyDbError(error: unknown): Error {
    const code = this.errorCode(error);

    // 28P01 invalid_password / 28000 invalid_authorization_specification.
    // The DB rejected our credentials — this is a secret/connection problem,
    // never an application bug. Surfacing it explicitly turns the otherwise
    // confusing "500 on /auth/github/start" into a one-line root cause.
    if (code === '28P01' || code === '28000') {
      this.logger.error(
        `Database rejected credentials (SQLSTATE ${code}). This is a credential/connection problem, not an application bug — verify SUPABASE_DB_URL's user/password against the live Supabase project (e.g. after a password rotation or a deploy with a stale env var).`,
      );
      return new ServiceUnavailableException(
        'Database authentication failed. The service cannot reach its database.',
      );
    }

    if (this.isRetryableConnectionError(error)) {
      this.logger.error(
        `Database unreachable (${code || 'transport error'}); returning 503.`,
      );
      return new ServiceUnavailableException(
        'Database temporarily unavailable. Please retry.',
      );
    }

    return error instanceof Error ? error : new Error(String(error));
  }

  /** Extracts a pg SQLSTATE or Node socket error code, or '' if absent. */
  private errorCode(error: unknown): string {
    return typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
  }

  /**
   * True for transport/connection-level failures that are safe to retry on a
   * fresh connection (the statement never reached the server, or the server
   * went away). Deliberately excludes SQL errors (syntax, constraint, etc.).
   */
  private isRetryableConnectionError(error: unknown): boolean {
    const code = this.errorCode(error);
    // Postgres connection-failure SQLSTATEs + Node socket error codes.
    const retryableCodes = new Set([
      '08000', // connection_exception
      '08003', // connection_does_not_exist
      '08006', // connection_failure
      '57P01', // admin_shutdown
      '57P02', // crash_shutdown
      '57P03', // cannot_connect_now
      'ECONNRESET',
      'EPIPE',
      'ETIMEDOUT',
      'ENOTFOUND',
      // "Never reached the server" failures: DNS resolved but the socket could
      // not be opened at all. Safe to retry for the same reason as the codes
      // above — the statement was never executed, so there is no double-apply
      // risk. ENETUNREACH in particular is what Render returns when the DB URL
      // points at Supabase's IPv6-only direct host (db.<ref>.supabase.co)
      // instead of the IPv4-reachable Supavisor pooler.
      'ECONNREFUSED',
      'ENETUNREACH',
      'EHOSTUNREACH',
    ]);
    if (retryableCodes.has(code)) {
      return true;
    }

    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error);
    return (
      message.includes('connection terminated') ||
      message.includes('server closed the connection') ||
      message.includes('connection ended unexpectedly') ||
      message.includes('client has encountered a connection error')
    );
  }

  async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const pool = this.getPoolOrThrow();
    const client = await pool.connect();

    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (!this.pool) {
      return;
    }

    await this.pool.end();
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  private getPoolOrThrow(): Pool {
    if (!this.pool) {
      throw new ServiceUnavailableException(
        'Database is not configured. Set SUPABASE_DB_URL.',
      );
    }

    return this.pool;
  }
}
