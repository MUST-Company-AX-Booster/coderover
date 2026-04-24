import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Role } from '../auth/roles.enum';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AdminConfigService } from './admin-config.service';
import { CleanupLegacySettingsDto, TestLlmConfigDto, UpdateLlmConfigDto, UpdateSettingDto } from './dto/update-setting.dto';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin)
@Controller('admin')
export class AdminConfigController {
  constructor(private readonly adminConfigService: AdminConfigService) {}

  @Get('settings')
  @ApiOperation({ summary: 'List managed system settings (secrets redacted)' })
  @ApiOkResponse({ description: 'Managed settings list' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async getSettings() {
    return this.adminConfigService.listSettings();
  }

  @Put('settings/:key')
  @ApiOperation({ summary: 'Update one managed system setting' })
  @ApiParam({ name: 'key', example: 'LLM_PROVIDER' })
  @ApiBody({ type: UpdateSettingDto })
  @ApiOkResponse({ description: 'Updated setting metadata' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async updateSetting(
    @Param('key') key: string,
    @Body() dto: UpdateSettingDto,
    @CurrentUser() user: any,
  ) {
    return this.adminConfigService.updateSetting(
      key,
      dto.value,
      user?.sub || user?.email || 'unknown',
      dto.reason,
      dto.expectedVersion,
    );
  }

  @Get('settings/audit')
  @ApiOperation({ summary: 'List system setting audit records' })
  @ApiQuery({ name: 'limit', required: false, example: '100' })
  @ApiOkResponse({ description: 'Audit trail entries' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async getAudit(@Query('limit', new ParseIntPipe({ optional: true })) limit?: number) {
    return this.adminConfigService.listAudit(limit ?? 100);
  }

  @Post('settings/cleanup-legacy-defaults')
  @ApiOperation({ summary: 'Delete legacy DEFAULT_REPO and DEFAULT_BRANCH settings rows' })
  @ApiBody({ type: CleanupLegacySettingsDto })
  @ApiOkResponse({ description: 'Cleanup result' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async cleanupLegacyDefaults(@Body() dto: CleanupLegacySettingsDto) {
    return this.adminConfigService.cleanupLegacyDefaultSettings(Boolean(dto?.dryRun));
  }

  @Get('llm/config')
  @ApiOperation({ summary: 'Get current LLM configuration (redacted)' })
  @ApiOkResponse({ description: 'Current LLM config' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async getLlmConfig() {
    return this.adminConfigService.getLlmConfig();
  }

  @Put('llm/config')
  @ApiOperation({ summary: 'Update LLM configuration values' })
  @ApiBody({ type: UpdateLlmConfigDto })
  @ApiOkResponse({ description: 'Updated LLM config result' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async updateLlmConfig(@Body() dto: UpdateLlmConfigDto, @CurrentUser() user: any) {
    return this.adminConfigService.updateLlmConfig(dto, user?.sub || user?.email || 'unknown');
  }

  @Post('llm/test')
  @ApiOperation({ summary: 'Test LLM provider connectivity' })
  @ApiBody({ type: TestLlmConfigDto })
  @ApiOkResponse({ description: 'Connectivity test result' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async testLlm(@Body() dto: TestLlmConfigDto) {
    return this.adminConfigService.testLlmConfig(dto);
  }
}
