(function attachTransientPreview(global) {
  "use strict";

  function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function adapt(detail, objectUrl, fallbackFilename = "上传图片") {
    if (!detail || typeof detail !== "object" || !objectUrl) {
      return null;
    }
    const sourceBatch = asRecord(detail.batch);
    const sourceImage = asRecord(
      Array.isArray(sourceBatch.images) && sourceBatch.images.length
        ? sourceBatch.images[0]
        : Array.isArray(detail.images) && detail.images.length
          ? asRecord(detail.images[0]).file
          : detail.file,
    );
    const filename = String(sourceImage.filename || fallbackFilename || "上传图片");
    const image = {
      ...sourceImage,
      filename,
      object_url: objectUrl,
      is_transient_upload: true,
    };
    const item = {
      ...detail,
      source_mode: "transient",
      batch: {
        ...sourceBatch,
        key: detail.batch_key || sourceBatch.key || filename,
        count: 1,
        images: [image],
        files_preview: [filename],
      },
    };
    return {
      meta: `临时解析 · ${filename}`,
      images: [image],
      item,
      transient: true,
      objectUrl,
    };
  }

  global.aaTransientPreview = global.wfdbTransientPreview = { adapt };
})(typeof window !== "undefined" ? window : globalThis);
