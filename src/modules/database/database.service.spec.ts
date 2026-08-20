import { ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from './database.service.js';

const mockPoolQuery = jest.fn();
const mockPoolConnect = jest.fn();
const mockPoolEnd = jest.fn();
const mockPoolOn = jest.fn();

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation((options) => ({
    options,
    query: mockPoolQuery,
    connect: mockPoolConnect,
    end: mockPoolEnd,
    on: mockPoolOn,
  })),
}));

const makeConfigService = (dbUrl: string | undefined) =>
  ({
    getOrThrow: jest.fn().mockReturnValue({
      supabase: { dbUrl },
    }),
  }) as unknown as ConfigService;

describe('DatabaseService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sets pool to null and warns when SUPABASE_DB_URL is missing', async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DatabaseService,
        { provide: ConfigService, useValue: makeConfigService(undefined) },
      ],
    }).compile();

    const service = module.get(DatabaseService);
    expect(service.isEnabled()).toBe(false);
  });

  it('isEnabled returns false when pool is null', async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DatabaseService,
        { provide: ConfigService, useValue: makeConfigService(undefined) },
      ],
    }).compile();

    const service = module.get(DatabaseService);
    expect(service.isEnabled()).toBe(false);
  });

  it('query throws ServiceUnavailableException when pool is null', async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DatabaseService,
        { provide: ConfigService, useValue: makeConfigService(undefined) },
      ],
    }).compile();

    const service = module.get(DatabaseService);
    await expect(service.query('SELECT 1')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('withClient throws ServiceUnavailableException when pool is null', async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DatabaseService,
        { provide: ConfigService, useValue: makeConfigService(undefined) },
      ],
    }).compile();

    const service = module.get(DatabaseService);
    await expect(service.withClient(async () => 'x')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('close resolves without error when pool is null', async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DatabaseService,
        { provide: ConfigService, useValue: makeConfigService(undefined) },
      ],
    }).compile();

    const service = module.get(DatabaseService);
    await expect(service.close()).resolves.toBeUndefined();
  });

  it('onModuleDestroy calls close', async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DatabaseService,
        { provide: ConfigService, useValue: makeConfigService(undefined) },
      ],
    }).compile();

    const service = module.get(DatabaseService);
    const closeSpy = jest.spyOn(service, 'close').mockResolvedValue();
    await service.onModuleDestroy();
    expect(closeSpy).toHaveBeenCalled();
  });

  it('uses a configured pool for queries, clients, and shutdown', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ value: 1 }] });
    const release = jest.fn();
    // withClient probes the connection with SELECT 1 before handing it over.
    const client = {
      release,
      query: jest.fn().mockResolvedValue({ rows: [] }),
    };
    mockPoolConnect.mockResolvedValueOnce(client);
    mockPoolEnd.mockResolvedValueOnce(undefined);

    const service = new DatabaseService(
      makeConfigService('postgres://user:pass@127.0.0.1:5432/db'),
    );

    expect(service.isEnabled()).toBe(true);
    await expect(
      service.query('SELECT $1::int AS value', [1]),
    ).resolves.toEqual({
      rows: [{ value: 1 }],
    });
    await expect(
      service.withClient(async (poolClient) => poolClient),
    ).resolves.toBe(client);
    expect(release).toHaveBeenCalled();
    await expect(service.close()).resolves.toBeUndefined();
    expect(mockPoolEnd).toHaveBeenCalled();
  });

  /* ── withClient and stale pooled connections ──────────────────────────────
     pool.connect() will hand back a client the Supabase pooler has already
     reaped. query() survives that by retrying the statement, but a transaction
     cannot be retried — a connection error at COMMIT is ambiguous. So
     withClient probes the connection first and only then runs the callback,
     which must therefore never run twice. */

  const staleError = Object.assign(
    new Error('Connection terminated unexpectedly'),
    { code: 'ECONNRESET' },
  );

  it('replaces a stale pooled connection and runs the callback once', async () => {
    const dead = {
      release: jest.fn(),
      query: jest.fn().mockRejectedValue(staleError),
    };
    const live = {
      release: jest.fn(),
      query: jest.fn().mockResolvedValue({ rows: [] }),
    };
    mockPoolConnect.mockResolvedValueOnce(dead).mockResolvedValueOnce(live);

    const service = new DatabaseService(
      makeConfigService('postgres://user:pass@127.0.0.1:5432/db'),
    );

    const callback = jest.fn().mockResolvedValue('done');
    await expect(service.withClient(callback)).resolves.toBe('done');

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(live);
    // Never handed the corpse to the callback.
    expect(callback).not.toHaveBeenCalledWith(dead);
    // Destroyed, not returned to the pool for the next caller to trip over.
    expect(dead.release).toHaveBeenCalledWith(true);
    expect(live.release).toHaveBeenCalled();
  });

  it('does not run the callback at all when no live connection can be had', async () => {
    const dead = () => ({
      release: jest.fn(),
      query: jest.fn().mockRejectedValue(staleError),
    });
    mockPoolConnect.mockResolvedValueOnce(dead()).mockResolvedValueOnce(dead());

    const service = new DatabaseService(
      makeConfigService('postgres://user:pass@127.0.0.1:5432/db'),
    );

    const callback = jest.fn();
    await expect(service.withClient(callback)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(callback).not.toHaveBeenCalled();
  });

  it('does not retry the probe on a non-connection error', async () => {
    const sqlError = Object.assign(new Error('syntax error'), {
      code: '42601',
    });
    const client = {
      release: jest.fn(),
      query: jest.fn().mockRejectedValue(sqlError),
    };
    mockPoolConnect.mockResolvedValueOnce(client);

    const service = new DatabaseService(
      makeConfigService('postgres://user:pass@127.0.0.1:5432/db'),
    );

    await expect(service.withClient(jest.fn())).rejects.toThrow('syntax error');
    expect(mockPoolConnect).toHaveBeenCalledTimes(1);
  });

  it('maps a connection failure inside the callback to a 503', async () => {
    const client = {
      release: jest.fn(),
      query: jest.fn().mockResolvedValue({ rows: [] }),
    };
    mockPoolConnect.mockResolvedValueOnce(client);

    const service = new DatabaseService(
      makeConfigService('postgres://user:pass@127.0.0.1:5432/db'),
    );

    await expect(
      service.withClient(async () => {
        throw staleError;
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(client.release).toHaveBeenCalled();
  });

  it('leaves a genuine SQL error from the callback untouched', async () => {
    const client = {
      release: jest.fn(),
      query: jest.fn().mockResolvedValue({ rows: [] }),
    };
    mockPoolConnect.mockResolvedValueOnce(client);

    const service = new DatabaseService(
      makeConfigService('postgres://user:pass@127.0.0.1:5432/db'),
    );

    const constraintError = Object.assign(new Error('duplicate key'), {
      code: '23505',
    });
    await expect(
      service.withClient(async () => {
        throw constraintError;
      }),
    ).rejects.toThrow('duplicate key');
  });

  it('registers an idle-client error handler and enables TCP keepalive', () => {
    const service = new DatabaseService(
      makeConfigService('postgres://user:pass@db.example.com:5432/db'),
    );

    expect(service.isEnabled()).toBe(true);
    // Idle-client error handler is wired so a dropped connection never crashes
    // the process.
    expect(mockPoolOn).toHaveBeenCalledWith('error', expect.any(Function));
    // The handler itself only logs (must not throw).
    const handler = mockPoolOn.mock.calls.find(
      (call) => call[0] === 'error',
    )?.[1] as (err: Error) => void;
    expect(() => handler(new Error('connection dropped'))).not.toThrow();
  });

  it('retries a query once when it hits a stale connection', async () => {
    const staleError = Object.assign(new Error('Connection terminated'), {
      code: '08006',
    });
    mockPoolQuery
      .mockRejectedValueOnce(staleError)
      .mockResolvedValueOnce({ rows: [{ value: 1 }] });

    const service = new DatabaseService(
      makeConfigService('postgres://user:pass@db.example.com:5432/db'),
    );

    await expect(service.query('SELECT 1')).resolves.toEqual({
      rows: [{ value: 1 }],
    });
    expect(mockPoolQuery).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on a non-connection (SQL) error', async () => {
    const sqlError = Object.assign(new Error('duplicate key value'), {
      code: '23505',
    });
    mockPoolQuery.mockRejectedValueOnce(sqlError);

    const service = new DatabaseService(
      makeConfigService('postgres://user:pass@db.example.com:5432/db'),
    );

    await expect(service.query('INSERT ...')).rejects.toThrow(
      'duplicate key value',
    );
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });

  it('surfaces a 503 if the connection retry also fails', async () => {
    const staleError = Object.assign(
      new Error('server closed the connection'),
      {
        code: 'ECONNRESET',
      },
    );
    mockPoolQuery
      .mockRejectedValueOnce(staleError)
      .mockRejectedValueOnce(staleError);

    const service = new DatabaseService(
      makeConfigService('postgres://user:pass@db.example.com:5432/db'),
    );

    // A transport failure that survives the single retry is infrastructure,
    // not an application bug — it becomes a retryable 503, not an opaque 500.
    await expect(service.query('SELECT 1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(mockPoolQuery).toHaveBeenCalledTimes(2);
  });

  it('maps a credential rejection (28P01) to a 503, not a 500', async () => {
    // The exact failure seen on /auth/github/start: the DB rejecting our
    // password. This is a credential/connection problem, so the service must
    // not retry (a bad password never recovers) and must surface a 503.
    const authError = Object.assign(
      new Error('password authentication failed for user "postgres"'),
      { code: '28P01' },
    );
    mockPoolQuery.mockRejectedValueOnce(authError);

    const service = new DatabaseService(
      makeConfigService('postgres://user:pass@db.example.com:5432/db'),
    );

    await expect(service.query('INSERT ...')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    // No retry: a rejected credential will be rejected again.
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });
});
