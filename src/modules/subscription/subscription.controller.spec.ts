import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { SubscriptionController } from './subscription.controller.js';
import { SubscriptionService } from './subscription.service.js';
import type { Request } from 'express';
import type {
  SessionUser,
  SubscriptionState,
} from '../../common/interfaces/session-user.interface.js';

const fakeUser: SessionUser = {
  id: 'user-1',
  login: 'testuser',
  onboardingCompleted: false,
  isInternal: false,
};

const fakeFreeSub: SubscriptionState = {
  plan: 'free',
  status: 'inactive',
  provider: 'supabase',
  updatedAt: '2026-01-01T00:00:00Z',
};

const fakeProSub: SubscriptionState = {
  plan: 'pro',
  status: 'active',
  provider: 'manual',
  updatedAt: '2026-01-01T00:00:00Z',
};

const makeRequest = (user: SessionUser | undefined = fakeUser) =>
  ({ session: { user } }) as unknown as Request;

// Use when testing the no-user path: passing `undefined` to makeRequest() would
// trigger the default parameter and silently use fakeUser instead.
const makeUnauthRequest = () => ({ session: {} }) as unknown as Request;

const makeSubscriptionService = () =>
  ({
    getForUser: jest.fn().mockResolvedValue(fakeFreeSub),
    createCheckoutSession: jest.fn().mockResolvedValue({
      checkoutId: 'cs_test_123',
      redirectUrl: 'https://checkout.paymongo.com/test',
    }),
    getCheckoutStatus: jest.fn().mockResolvedValue({ status: 'pending' }),
    handlePayMongoWebhook: jest.fn().mockResolvedValue({ received: true }),
    activateForUser: jest.fn().mockResolvedValue(fakeProSub),
    cancelForUser: jest.fn().mockResolvedValue(fakeFreeSub),
  }) as unknown as SubscriptionService;

describe('SubscriptionController', () => {
  let controller: SubscriptionController;
  let service: SubscriptionService;

  beforeEach(async () => {
    service = makeSubscriptionService();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SubscriptionController],
      providers: [{ provide: SubscriptionService, useValue: service }],
    })
      .overrideGuard(
        require('../../common/guards/session-auth.guard.js').SessionAuthGuard,
      )
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(SubscriptionController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getSubscription', () => {
    it('returns wrapped subscription', async () => {
      const result = await controller.getSubscription(makeRequest());
      expect(result).toEqual({ subscription: fakeFreeSub });
    });

    it('throws UnauthorizedException when no user in session', async () => {
      await expect(
        controller.getSubscription(makeUnauthRequest()),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('activateMonthly', () => {
    it('activates pro by default', async () => {
      const result = await controller.activateMonthly(makeRequest(), {});
      expect(service.activateForUser).toHaveBeenCalledWith(fakeUser, 'pro');
      expect(result).toEqual({ subscription: fakeProSub });
    });

    it('activates pro when specified', async () => {
      await controller.activateMonthly(makeRequest(), { plan: 'pro' });
      expect(service.activateForUser).toHaveBeenCalledWith(fakeUser, 'pro');
    });
  });

  describe('payment gateway removal', () => {
    it('exposes no checkout or provider-webhook endpoints', () => {
      const surface = controller as unknown as Record<string, unknown>;

      expect(surface['createCheckout']).toBeUndefined();
      expect(surface['getCheckoutStatus']).toBeUndefined();
      expect(surface['handlePayMongoWebhook']).toBeUndefined();
    });
  });

  describe('cancelMonthly', () => {
    it('cancels and returns updated state', async () => {
      const result = await controller.cancelMonthly(makeRequest());
      expect(service.cancelForUser).toHaveBeenCalledWith(fakeUser);
      expect(result).toEqual({ subscription: fakeFreeSub });
    });

    it('throws UnauthorizedException when no user in session', async () => {
      await expect(
        controller.cancelMonthly(makeUnauthRequest()),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
