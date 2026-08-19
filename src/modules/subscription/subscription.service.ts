import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../config/app.config';
import type {
  SessionUser,
  SubscriptionPlan,
  SubscriptionState,
} from '../../common/interfaces/session-user.interface';
import { OutboxRepository } from '../persistence/outbox.repository';
import { SubscriptionsRepository } from '../persistence/subscriptions.repository';

@Injectable()
export class SubscriptionService {
  private readonly config: AppConfig;

  constructor(
    private readonly configService: ConfigService,
    private readonly subscriptionsRepository: SubscriptionsRepository,
    private readonly outboxRepository: OutboxRepository,
  ) {
    this.config = this.configService.getOrThrow<AppConfig>('app');
  }

  async getForUser(user: SessionUser): Promise<SubscriptionState> {
    // Internal employees (company GitHub org members) and the global
    // gate-disabled mode are both fully entitled without a subscription row,
    // payment, or a visit to /subscribe.
    if (user.isInternal || this.config.subscription.gateEnabled === false) {
      return {
        plan: 'pro' as SubscriptionPlan,
        status: 'active' as const,
        provider: 'manual' as const,
        updatedAt: new Date().toISOString(),
        planCode: 'pro_monthly',
        currentPeriodStart: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        amountPhp: 0,
        interval: 'month' as const,
      };
    }

    const existing = await this.subscriptionsRepository.getCurrentByUserId(
      user.id,
    );
    if (existing) {
      return existing;
    }

    const seededPlan =
      this.config.subscription.seededPlans[user.login] ??
      this.config.subscription.seededPlans[user.id];
    const plan = seededPlan ?? this.config.subscription.defaultPlan;

    if (plan === 'pro') {
      return this.subscriptionsRepository.activateMonthlyPlan(
        user.id,
        'pro_monthly',
        this.config.subscription.proMonthlyPricePhp,
        'manual',
      );
    }

    return this.subscriptionsRepository.ensureDefaultFreeSubscription(user.id);
  }

  async activateForUser(
    user: SessionUser,
    _plan: SubscriptionPlan = 'pro',
  ): Promise<SubscriptionState> {
    void _plan;
    this.assertMockEnabled();

    return this.activatePaidPlan(user.id, 'manual');
  }

  async cancelForUser(user: SessionUser): Promise<SubscriptionState> {
    const nextState = await this.subscriptionsRepository.cancelCurrent(user.id);

    await this.outboxRepository.publishLater({
      topic: 'subscription.canceled',
      aggregateType: 'subscription',
      aggregateId: user.id,
      payload: {
        userId: user.id,
        plan: nextState.plan,
        planCode: nextState.planCode,
      },
    });

    return nextState;
  }

  private assertMockEnabled(): void {
    if (!this.config.subscription.mockEnabled) {
      throw new ForbiddenException('Subscription mock endpoints are disabled');
    }
  }

  private async activatePaidPlan(
    userId: string,
    provider: 'manual' = 'manual',
  ): Promise<SubscriptionState> {
    const nextState = await this.subscriptionsRepository.activateMonthlyPlan(
      userId,
      'pro_monthly',
      this.config.subscription.proMonthlyPricePhp,
      provider,
    );

    await this.outboxRepository.publishLater({
      topic: 'subscription.activated',
      aggregateType: 'subscription',
      aggregateId: userId,
      payload: {
        userId,
        plan: nextState.plan,
        planCode: nextState.planCode,
      },
    });

    return nextState;
  }
}
