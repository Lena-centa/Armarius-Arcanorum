import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ImageLineageDocument = HydratedDocument<ImageLineage>;

@Schema({ collection: 'image_lineage_edges', timestamps: false })
export class ImageLineage {
  @Prop({ required: true }) edge_id!: string;
  @Prop({ required: true }) child_sha256!: string;
  @Prop() child_batch_key?: string;
  @Prop() parent_sha256?: string;
  @Prop() parent_batch_key?: string;
  @Prop({ required: true }) relation_type!: string;
  @Prop({ required: true }) origin!: string;
  @Prop({ required: true }) status!: string;
  @Prop() raw_ref?: string;
  @Prop() source_node_id?: string;
  @Prop() source_node_type?: string;
  @Prop() source_content_sha256?: string;
  @Prop() match_method?: string;
  /**
   * 该来源图喂到的 ControlNet 应用列表(仅 controlnet 关系有值)。
   * Mongo 侧存数组,SQLite 侧同列存 JSON 文本(见 lineage.service 的读写)。
   */
  @Prop() downstream?: unknown[];
  @Prop({ default: true }) active!: boolean;
  @Prop() created_at?: Date;
  @Prop() updated_at?: Date;
}

export const ImageLineageSchema = SchemaFactory.createForClass(ImageLineage);
ImageLineageSchema.index({ edge_id: 1 }, { name: 'uniq_lineage_edge_id', unique: true });
ImageLineageSchema.index({ child_sha256: 1 }, { name: 'lineage_child_sha256' });
ImageLineageSchema.index({ parent_sha256: 1 }, { name: 'lineage_parent_sha256' });
ImageLineageSchema.index({ status: 1 }, { name: 'lineage_status' });
ImageLineageSchema.index({ source_content_sha256: 1 }, { name: 'lineage_content_sha256' });
