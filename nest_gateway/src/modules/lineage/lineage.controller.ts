import { BadRequestException, Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { RequireAuth } from '../../common/auth';
import {
  LINEAGE_RELATION_TYPES,
  LineageDirection,
  LineageRelationType,
  LineageService,
} from './lineage.service';

const SHA_RE = /^[0-9a-f]{64}$/i;

@Controller('api/image')
export class LineageController {
  constructor(private readonly lineage: LineageService) {}

  @RequireAuth()
  @Post('lineage/backfill')
  async backfill(@Query('dry_run') dryRun?: string): Promise<Record<string, unknown>> {
    return this.lineage.backfill(dryRun === '1' || dryRun === 'true');
  }

  @Get(':sha256/lineage')
  async getLineage(
    @Param('sha256') sha256: string,
    @Query('direction') directionRaw?: string,
    @Query('depth') depthRaw?: string,
  ): Promise<Record<string, unknown>> {
    if (!SHA_RE.test(sha256)) throw new BadRequestException('invalid sha256');
    const direction = (directionRaw ?? 'both') as LineageDirection;
    if (!['ancestors', 'descendants', 'both'].includes(direction)) {
      throw new BadRequestException('invalid direction');
    }
    const depth = Math.min(6, Math.max(1, Number.parseInt(depthRaw ?? '1', 10) || 1));
    return this.lineage.getGraph(sha256, direction, depth);
  }

  /**
   * POST /api/image/lineage/marks — 批量血缘标记(列表页 i2i 角标用)。
   * 列表页整页只调一次:传入当前页所有 sha,返回有 i2i 关系的那些。
   * 只读端点(与 GET /:sha256/lineage 同权限),不入鉴权白名单。
   * @param body { shas: string[] } 非法值剔除,上限 500(见 LineageService.marks)
   * @returns { marks: { [sha256]: { as_product, as_product_linked, as_source } } }
   */
  @Post('lineage/marks')
  async lineageMarks(
    @Body() body: { shas?: unknown },
  ): Promise<Record<string, unknown>> {
    const raw = (body ?? {}).shas;
    return { marks: await this.lineage.marks(Array.isArray(raw) ? (raw as string[]) : []) };
  }

  @RequireAuth()
  @Put(':sha256/lineage/manual')
  async setManual(
    @Param('sha256') sha256: string,
    @Body() body: { relation_type?: string; parent_sha256s?: string[] },
  ): Promise<{ ok: true }> {
    if (!SHA_RE.test(sha256)) throw new BadRequestException('invalid sha256');
    const relationType = body.relation_type as LineageRelationType;
    if (!LINEAGE_RELATION_TYPES.includes(relationType)) {
      throw new BadRequestException('invalid relation_type');
    }
    if (!Array.isArray(body.parent_sha256s) || body.parent_sha256s.some((value) => typeof value !== 'string' || !SHA_RE.test(value))) {
      throw new BadRequestException('parent_sha256s must contain valid sha256 values');
    }
    await this.lineage.setManualParents(sha256, relationType, body.parent_sha256s);
    return { ok: true };
  }
}
