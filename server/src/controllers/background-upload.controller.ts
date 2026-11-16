import { BadRequestException, Body, Controller, Delete, Header, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { BackgroundUploadCreateDto } from 'src/dtos/background-upload.dto.js';
import { Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { BackgroundUploadService } from 'src/services/background-upload.service.js';
import { backgroundPartBytes } from 'src/utils/background-upload.js';

@Controller('assets/background-uploads')
export class BackgroundUploadController {
  constructor(private service: BackgroundUploadService) {}

  @Post()
  @Header('Cache-Control', 'no-store')
  @Authenticated({ permission: Permission.AssetUpload })
  start(@Auth() auth: AuthDto, @Body() dto: BackgroundUploadCreateDto) {
    return this.service.start(auth, dto);
  }

  @Post(':id/status')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Authenticated({ permission: Permission.AssetUpload })
  status(@Auth() auth: AuthDto, @Param('id') id: string) {
    return this.service.status(auth, id);
  }

  @Put(':id/parts/:offset')
  @HttpCode(204)
  @Authenticated({ public: true })
  async stage(@Param('id') id: string, @Param('offset') rawOffset: string, @Req() request: Request) {
    const capability = request.get('X-Upload-Capability') ?? '';
    await this.service.authorizePart(id, capability);
    if (!/^\d+$/.test(rawOffset)) {
      throw new BadRequestException('Invalid offset');
    }
    const bytes: Buffer[] = [];
    let length = 0;
    for await (const data of request) {
      const chunk = Buffer.from(data);
      length += chunk.length;
      if (length > backgroundPartBytes + 28) {
        throw new BadRequestException('Upload part is too large');
      }
      bytes.push(chunk);
    }
    await this.service.stage(id, capability, Number(rawOffset), Buffer.concat(bytes));
  }

  @Delete(':id')
  @HttpCode(204)
  @Authenticated({ permission: Permission.AssetUpload })
  cancel(@Auth() auth: AuthDto, @Param('id') id: string) {
    return this.service.cancel(auth, id);
  }
}
