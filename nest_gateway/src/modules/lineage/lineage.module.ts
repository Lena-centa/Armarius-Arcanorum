import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  ImageLineage,
  ImageLineageSchema,
  Images,
  ImagesSchema,
} from '../../schemas';
import { WorkersModule } from '../../workers/workers.module';
import { LineageController } from './lineage.controller';
import { LineageService } from './lineage.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Images.name, schema: ImagesSchema },
      { name: ImageLineage.name, schema: ImageLineageSchema },
    ]),
    WorkersModule,
  ],
  controllers: [LineageController],
  providers: [LineageService],
  exports: [LineageService],
})
export class LineageModule {}
