import { Module } from '@nestjs/common';
import { PluginRegistryService } from './plugin-registry.service';
import { PluginsController } from './plugins.controller';

@Module({
  controllers: [PluginsController],
  providers: [PluginRegistryService],
  exports: [PluginRegistryService],
})
export class PluginsModule {}
