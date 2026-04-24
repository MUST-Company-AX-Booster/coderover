import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SearchModule } from '../search/search.module';
import { DebugController } from './debug.controller';

@Module({
  imports: [AuthModule, SearchModule],
  controllers: [DebugController],
})
export class DebugModule {}
