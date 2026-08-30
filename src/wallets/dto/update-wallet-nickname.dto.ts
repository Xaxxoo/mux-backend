import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateWalletNicknameDto {
  /**
   * Human-readable label for the wallet (e.g. "Savings", "Hot wallet").
   * Pass `null` to clear an existing nickname.
   */
  @ApiPropertyOptional({
    example: 'Savings wallet',
    description:
      'Human-readable label for the wallet. Pass null to clear the nickname.',
    maxLength: 100,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  nickname?: string | null;
}
