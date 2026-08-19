import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import type { SessionUser } from '../../common/interfaces/session-user.interface';
import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { ActivateSubscriptionDto } from './dto/activate-subscription.dto';
import { SubscriptionService } from './subscription.service';

@Controller('subscription')
export class SubscriptionController {
  constructor(private readonly subscriptionService: SubscriptionService) {}

  @Get('me')
  @UseGuards(SessionAuthGuard)
  async getSubscription(@Req() req: Request) {
    const user = this.getUser(req);

    return {
      subscription: await this.subscriptionService.getForUser(user),
    };
  }

  // Entitlement is granted by contract on this deployment, so activation is an
  // administrative action rather than the tail end of a hosted checkout. The
  // self-serve payment endpoints (checkout, checkout status, provider webhook)
  // were removed with the payment gateway.
  @Post('monthly/activate')
  @UseGuards(SessionAuthGuard)
  async activateMonthly(
    @Req() req: Request,
    @Body() body: ActivateSubscriptionDto,
  ) {
    return this.activateInternal(req, body);
  }

  @Post('monthly/cancel')
  @UseGuards(SessionAuthGuard)
  async cancelMonthly(@Req() req: Request) {
    return this.cancelInternal(req);
  }

  private async activateInternal(req: Request, body: ActivateSubscriptionDto) {
    const user = this.getUser(req);

    return {
      subscription: await this.subscriptionService.activateForUser(
        user,
        body.plan ?? 'pro',
      ),
    };
  }

  private async cancelInternal(req: Request) {
    const user = this.getUser(req);

    return {
      subscription: await this.subscriptionService.cancelForUser(user),
    };
  }

  private getUser(req: Request): SessionUser {
    const user = req.session?.user;
    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    return user;
  }
}
