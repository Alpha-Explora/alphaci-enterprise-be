import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';

import type { GrantableRole } from '../hierarchy.types';

/**
 * Body for POST /groups/:groupId/members — a lead granting membership
 * directly. There is no invitation step and nothing for the recipient to
 * accept.
 *
 * `role` is optional and defaults to 'member'. 'admin' is deliberately absent:
 * group ownership only moves via the transfer endpoint.
 */
export class AddGroupMemberDto {
  @IsString()
  @MinLength(1)
  userId: string = '';

  @IsOptional()
  @IsIn(['delegated_lead', 'member', 'viewer'])
  role?: GrantableRole;
}
