/**
 * 生成图片在存储/统计投影中的稳定定位键。
 *
 * 本地图保持历史 resolved_path 语义;独立远端图片库没有本地
 * 路径时,生成 remote://<instance>/<asset> 逻辑 URI。该 URI 只是数据库键,
 * 不会作为文件系统路径打开。
 */
export function imageLocationKey(
  image: {
    file?: {
      resolved_path?: unknown;
      sha256?: unknown;
      filename?: unknown;
    };
    source?: {
      instance_id?: unknown;
      asset_id?: unknown;
    } | null;
  },
): string | null {
  const text = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
  };
  const resolvedPath = text(image.file?.resolved_path);
  if (resolvedPath) return resolvedPath;
  const token =
    text(image.source?.asset_id) ??
    text(image.file?.sha256) ??
    text(image.file?.filename);
  if (!token) return null;
  const instanceId = text(image.source?.instance_id) ?? 'remote';
  return `remote://${encodeURIComponent(instanceId)}/${encodeURIComponent(token)}`;
}
