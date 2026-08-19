import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import { CiService } from './ci.service';
import type { CiTokensRepository } from './ci-tokens.repository';

const makeRepository = () =>
  ({
    upsertProjectToken: jest.fn(),
    findValidationContext: jest.fn(),
    revokeProjectTokens: jest.fn(),
  }) as unknown as CiTokensRepository;

/**
 * gateEnabled is the only config CiService reads. `true` reproduces the
 * subscription-gated deployment; `false` is the contract-billed enterprise
 * deployment where entitlement is granted outside the product.
 */
const makeConfigService = (gateEnabled: boolean) =>
  ({
    getOrThrow: () => ({ subscription: { gateEnabled } }),
  }) as unknown as ConfigService;

/** A context row that passes every check except the entitlement rule. */
const validContext = (overrides: Record<string, unknown> = {}) => ({
  project_id: 'project-1',
  user_id: 'user-1',
  repo_full_name: 'owner/repo',
  project_status: 'provisioned',
  token_status: 'active',
  subscription_status: 'active',
  is_internal: false,
  ...overrides,
});

describe('CiService', () => {
  let repository: CiTokensRepository;
  let service: CiService;

  beforeEach(() => {
    repository = makeRepository();
    service = new CiService(repository, makeConfigService(true));
  });

  it('issues an opaque project token and persists only its hash', async () => {
    (repository.upsertProjectToken as jest.Mock).mockResolvedValueOnce(
      undefined,
    );

    const result = await service.issueProjectToken('project-1');

    expect(result.token).toMatch(/^aci_[A-Za-z0-9_-]{32,}$/);
    expect(result.tokenPrefix).toBe(result.token.slice(0, 12));
    expect(repository.upsertProjectToken).toHaveBeenCalledWith({
      projectId: 'project-1',
      tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      tokenPrefix: result.tokenPrefix,
    });
    expect(repository.upsertProjectToken).not.toHaveBeenCalledWith(
      expect.objectContaining({ token: result.token }),
    );
  });

  it('validates an active token for a provisioned project and repo', async () => {
    (repository.findValidationContext as jest.Mock).mockResolvedValueOnce(
      validContext(),
    );

    const result = await service.validateRun({
      token: 'aci_valid-token',
      repoFullName: 'owner/repo',
      stage: 'quality',
    });

    expect(result).toEqual({
      authorized: true,
      projectId: 'project-1',
      repoFullName: 'owner/repo',
      stage: 'quality',
    });
  });

  it('rejects a missing bearer token', async () => {
    await expect(
      service.validateRun({
        token: '',
        repoFullName: 'owner/repo',
        stage: 'gate',
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a token that does not match the repo', async () => {
    (repository.findValidationContext as jest.Mock).mockResolvedValueOnce(null);

    await expect(
      service.validateRun({
        token: 'aci_valid-token',
        repoFullName: 'other/repo',
        stage: 'quality',
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects inactive subscriptions while the gate is enabled', async () => {
    (repository.findValidationContext as jest.Mock).mockResolvedValueOnce(
      validContext({ subscription_status: 'inactive' }),
    );

    await expect(
      service.validateRun({
        token: 'aci_valid-token',
        repoFullName: 'owner/repo',
        stage: 'quality',
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('authorises an internal user with no subscription row', async () => {
    (repository.findValidationContext as jest.Mock).mockResolvedValueOnce(
      validContext({ subscription_status: null, is_internal: true }),
    );

    await expect(
      service.validateRun({
        token: 'aci_valid-token',
        repoFullName: 'owner/repo',
        stage: 'quality',
      }),
    ).resolves.toMatchObject({ authorized: true, projectId: 'project-1' });
  });

  describe('with the subscription gate disabled (contract-billed)', () => {
    beforeEach(() => {
      service = new CiService(repository, makeConfigService(false));
    });

    it('authorises a provisioned project with no subscription at all', async () => {
      (repository.findValidationContext as jest.Mock).mockResolvedValueOnce(
        validContext({ subscription_status: null, is_internal: false }),
      );

      await expect(
        service.validateRun({
          token: 'aci_valid-token',
          repoFullName: 'owner/repo',
          stage: 'quality',
        }),
      ).resolves.toMatchObject({ authorized: true });
    });

    it('still rejects a revoked token', async () => {
      (repository.findValidationContext as jest.Mock).mockResolvedValueOnce(
        validContext({ token_status: 'revoked' }),
      );

      await expect(
        service.validateRun({
          token: 'aci_valid-token',
          repoFullName: 'owner/repo',
          stage: 'quality',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('still rejects a project that is not provisioned', async () => {
      (repository.findValidationContext as jest.Mock).mockResolvedValueOnce(
        validContext({ project_status: 'provisioning' }),
      );

      await expect(
        service.validateRun({
          token: 'aci_valid-token',
          repoFullName: 'owner/repo',
          stage: 'quality',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
