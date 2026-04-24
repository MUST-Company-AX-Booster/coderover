import { Controller, Post, Get, Delete, Body, Param, Res, UseGuards, Header, Logger, HttpCode } from '@nestjs/common';
import { Response } from 'express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CopilotService } from './copilot.service';
import { SessionService } from './session.service';
import { ChatRequestDto } from './dto/chat-request.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('copilot')
@ApiBearerAuth()
@Controller('copilot')
@UseGuards(JwtAuthGuard)
export class CopilotController {
  private readonly logger = new Logger(CopilotController.name);

  constructor(
    private readonly copilotService: CopilotService,
    private readonly sessionService: SessionService,
  ) {}

  /** Stream a chat response as Server-Sent Events */
  @Post('chat')
  @ApiOperation({ summary: 'Stream chat answer over Server-Sent Events' })
  @ApiBody({
    type: ChatRequestDto,
    examples: {
      default: {
        summary: 'Basic chat request',
        value: {
          message: 'Explain current ingestion status and next actions.',
          stream: true,
        },
      },
    },
  })
  @ApiOkResponse({
    description: 'SSE stream with chunk/tool_call/sources/done events',
    content: {
      'text/event-stream': {
        schema: { type: 'string', example: 'event: chunk\ndata: {"content":"Hello"}\n\n' },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @Header('Content-Type', 'text/event-stream')
  @Header('Cache-Control', 'no-cache')
  @Header('Connection', 'keep-alive')
  async chat(@Body() dto: ChatRequestDto, @Res() res: Response) {
    this.logger.log(`Chat request: "${dto.message.substring(0, 50)}..."`);
    return this.copilotService.chat(dto, res);
  }

  /** Get all chat sessions for the current user */
  @Get('sessions')
  @ApiOperation({ summary: 'List chat sessions for the authenticated user' })
  @ApiOkResponse({
    description: 'Chat sessions list',
    schema: {
      example: [
        {
          id: '7de53c38-0f4e-4ea5-b5fd-f844ed53af3f',
          title: 'Auth flow review',
          createdAt: '2026-03-16T09:10:11.000Z',
          updatedAt: '2026-03-16T09:12:19.000Z',
        },
      ],
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async getSessions(@CurrentUser() user: any) {
    return this.sessionService.getUserSessions(user?.userId ?? 'anonymous');
  }

  /** Get message history for a specific session */
  @Get('sessions/:id/history')
  @ApiOperation({ summary: 'Get message history for one session' })
  @ApiParam({
    name: 'id',
    description: 'Session ID',
    example: '7de53c38-0f4e-4ea5-b5fd-f844ed53af3f',
  })
  @ApiOkResponse({
    description: 'Messages in chronological order',
    schema: {
      example: [
        { role: 'user', content: 'How does auth work?', createdAt: '2026-03-16T09:11:00.000Z' },
        { role: 'assistant', content: 'JWT auth guard protects endpoints.', createdAt: '2026-03-16T09:11:02.000Z' },
      ],
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async getHistory(@Param('id') sessionId: string) {
    return this.sessionService.getSessionHistory(sessionId);
  }

  /** Delete a chat session and all its messages */
  @Delete('sessions/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a chat session and its messages' })
  @ApiParam({
    name: 'id',
    description: 'Session ID',
    example: '7de53c38-0f4e-4ea5-b5fd-f844ed53af3f',
  })
  @ApiOkResponse({ description: 'Session deleted' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  async deleteSession(@Param('id') sessionId: string) {
    await this.sessionService.deleteSession(sessionId);
  }
}
