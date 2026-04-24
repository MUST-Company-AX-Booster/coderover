import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PluginRegistryService } from './plugin-registry.service';

@Controller('plugins')
@UseGuards(JwtAuthGuard)
export class PluginsController {
  constructor(private readonly registry: PluginRegistryService) {}

  @Get()
  list() {
    return this.registry.list();
  }
}
