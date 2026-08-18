import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';

import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import type { FeedbackStatus } from '../feedback/feedback.repository';
import { AdminService } from './admin.service';
import { GrantRoleDto } from './dto/grant-role.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { SetAppRoleDto } from './dto/set-app-role.dto';
import { PlatformAdminGuard } from './guards/platform-admin.guard';
import { SuperAdminGuard } from './guards/super-admin.guard';

/**
 * Platform admin API. Every route is locked by the class-level guards
 * (SessionAuthGuard → PlatformAdminGuard), so a new endpoint is admin-only by
 * default. The two role-mutation routes additionally require SuperAdminGuard.
 */
@Controller('admin')
@UseGuards(SessionAuthGuard, PlatformAdminGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('users')
  listUsers(@Req() req: Request, @Query() query: ListUsersQueryDto) {
    return this.adminService.listUsers(this.actorId(req), {
      search: query.search,
      limit: query.limit,
      offset: query.offset,
    });
  }

  @Get('users/:id')
  getUser(@Req() req: Request, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.adminService.getUserDetail(this.actorId(req), id);
  }

  @Get('users/:id/errors')
  getUserErrors(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.adminService.getUserErrors(this.actorId(req), id);
  }

  @Get('admins')
  listAdmins() {
    return this.adminService.listAdmins();
  }

  @Post('users/:id/role')
  @UseGuards(SuperAdminGuard)
  grantRole(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: GrantRoleDto,
  ) {
    return this.adminService.grantRole(this.actorId(req), id, dto.role);
  }

  @Delete('users/:id/role')
  @UseGuards(SuperAdminGuard)
  revokeRole(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.adminService.revokeRole(this.actorId(req), id);
  }

  // Global hierarchy role (Admin / Lead / Member) — the single place roles are
  // assigned. Open to ANY platform admin (the class-level PlatformAdminGuard),
  // NOT just super-admins: Alpha-Explora org owners are provisioned as platform
  // admins and are expected to manage hierarchy roles. This is deliberately a
  // lower bar than the grant/revoke PLATFORM-role routes above, which stay
  // super-admin only because they hand out platform-admin powers themselves.
  @Patch('users/:id/app-role')
  setAppRole(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SetAppRoleDto,
  ) {
    return this.adminService.setAppRole(this.actorId(req), id, dto.role);
  }

  /**
   * Unpins a user from a manual role so GitHub org team membership drives it
   * again. The new role lands on their next login or membership webhook.
   */
  @Post('users/:id/app-role/reset')
  resetAppRole(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.adminService.resetAppRoleToGithub(this.actorId(req), id);
  }

  @Get('feedback')
  listFeedback(@Req() req: Request, @Query('status') status?: FeedbackStatus) {
    return this.adminService.listFeedback(this.actorId(req), status);
  }

  @Patch('feedback/:id')
  triageFeedback(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: { status?: FeedbackStatus; adminResponse?: string },
  ) {
    return this.adminService.triageFeedback(this.actorId(req), id, body);
  }

  @Get('access-log')
  getAccessLog(@Req() req: Request) {
    return this.adminService.getAccessLog(this.actorId(req));
  }

  private actorId(req: Request): string {
    const userId = req.session?.user?.id ?? req.session?.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    return userId;
  }
}
