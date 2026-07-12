import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { sunoClient } from '../suno-client.js';
import { getToken } from '../ws-bridge.js';

function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
}

async function uploadFileToS3(url, fields, fileBuffer, contentType) {
  // Build multipart form data
  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
  let body = '';

  for (const [key, value] of Object.entries(fields)) {
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="${key}"\r\n\r\n`;
    body += `${value}\r\n`;
  }

  body += `--${boundary}\r\n`;
  body += `Content-Disposition: form-data; name="file"; filename="upload${extname(url || '.bin')}"\r\n`;
  body += `Content-Type: ${contentType}\r\n\r\n`;

  const encoder = new TextEncoder();
  const headerBytes = encoder.encode(body);
  const footerBytes = encoder.encode(`\r\n--${boundary}--\r\n`);

  const combined = new Uint8Array(headerBytes.length + fileBuffer.length + footerBytes.length);
  combined.set(headerBytes, 0);
  combined.set(new Uint8Array(fileBuffer), headerBytes.length);
  combined.set(footerBytes, headerBytes.length + fileBuffer.length);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: combined,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`S3 upload failed: HTTP ${response.status} ${text}`);
  }
}

export function registerUploadTools(server, allTools) {
  const tools = [
    tool('upload_audio', 'Upload an audio file to Suno', {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the audio file on disk' },
        title: { type: 'string', description: 'Title for the uploaded clip' },
        upload_type: { type: 'string', description: 'Upload type (studio_file_upload, etc.)', default: 'studio_file_upload' },
        is_stem_mix: { type: 'boolean', description: 'Whether the file is a stem mix', default: false },
        initialize_clip: { type: 'boolean', description: 'Whether to initialize a clip after upload', default: true },
      },
      required: ['file_path'],
    }, async (args) => {
      const fileBuffer = await readFile(args.file_path);
      const ext = extname(args.file_path).replace('.', '') || 'mp3';

      // Step 1: Initiate upload
      const initResult = await sunoClient.POST('/api/uploads/audio/', {
        body: { extension: ext, is_stem_mix: args.is_stem_mix || false, upload_type: args.upload_type || 'studio_file_upload' },
      });
      if (!initResult.ok) throw new Error(initResult.error || 'Upload initiation failed');
      const { id: uploadId, url: s3Url, fields: s3Fields } = initResult.data;
      if (!uploadId || !s3Url) throw new Error('Invalid upload initiation response');

      // Step 2: Upload to S3
      const contentType = `audio/${ext === 'mp3' ? 'mpeg' : ext === 'wav' ? 'wav' : ext === 'm4a' ? 'mp4' : ext === 'flac' ? 'flac' : ext === 'ogg' ? 'ogg' : ext === 'aac' ? 'aac' : 'mpeg'}`;
      await uploadFileToS3(s3Url, s3Fields, fileBuffer, contentType);

      // Step 3: Finish upload
      const filename = args.file_path.split('/').pop() || 'unknown';
      const finishResult = await sunoClient.POST(`/api/uploads/audio/${encodeURIComponent(uploadId)}/upload-finish/`, {
        body: { upload_type: args.upload_type || 'studio_file_upload', upload_filename: filename },
      });
      if (!finishResult.ok) throw new Error(finishResult.error || 'Upload finish failed');

      // Step 4: Optionally initialize clip
      if (args.initialize_clip) {
        const clipResult = await sunoClient.POST(`/api/uploads/audio/${encodeURIComponent(uploadId)}/initialize-clip/`, {
          body: { user_reviewed_tags: true },
        });
        if (!clipResult.ok) throw new Error(clipResult.error || 'Clip initialization failed');

        // Set title if provided
        if (args.title && clipResult.data?.clip_id) {
          await sunoClient.POST(`/api/gen/${encodeURIComponent(clipResult.data.clip_id)}/set_metadata/`, {
            body: { title: args.title },
          }).catch(() => {}); // non-critical
        }

        return { content: [{ type: 'text', text: JSON.stringify({ upload_id: uploadId, clip_id: clipResult.data?.clip_id, status: 'completed' }, null, 2) }] };
      }

      return { content: [{ type: 'text', text: JSON.stringify({ upload_id: uploadId, status: 'completed' }, null, 2) }] };
    }),

    tool('upload_image', 'Upload a cover image to Suno', {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the image file on disk' },
      },
      required: ['file_path'],
    }, async (args) => {
      const fileBuffer = await readFile(args.file_path);
      const ext = extname(args.file_path).replace('.', '') || 'jpg';

      const initResult = await sunoClient.POST('/api/uploads/image/', {
        body: { extension: ext },
      });
      if (!initResult.ok) throw new Error(initResult.error || 'Image upload initiation failed');
      const { id: uploadId, url: s3Url, fields: s3Fields } = initResult.data;
      if (!uploadId || !s3Url) throw new Error('Invalid upload initiation response');

      const contentType = `image/${ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : ext === 'png' ? 'png' : ext === 'webp' ? 'webp' : ext === 'gif' ? 'gif' : 'jpeg'}`;
      await uploadFileToS3(s3Url, s3Fields, fileBuffer, contentType);

      const finishResult = await sunoClient.POST(`/api/uploads/image/${encodeURIComponent(uploadId)}/upload-finish/`);
      if (!finishResult.ok) throw new Error(finishResult.error || 'Image upload finish failed');

      return { content: [{ type: 'text', text: JSON.stringify({ upload_id: uploadId, moderation_status: finishResult.data?.moderation_status }, null, 2) }] };
    }),

    tool('upload_video', 'Upload a video file to Suno', {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to the video file on disk' },
        is_video_cover: { type: 'boolean', description: 'Whether this is a cover art video', default: false },
        clip_id: { type: 'string', description: 'Optional clip ID to associate with' },
      },
      required: ['file_path'],
    }, async (args) => {
      const fileBuffer = await readFile(args.file_path);
      const ext = extname(args.file_path).replace('.', '') || 'mp4';

      const initResult = await sunoClient.POST('/api/uploads/video/', {
        body: { extension: ext },
      });
      if (!initResult.ok) throw new Error(initResult.error || 'Video upload initiation failed');
      const { id: uploadId, url: s3Url, fields: s3Fields } = initResult.data;
      if (!uploadId || !s3Url) throw new Error('Invalid upload initiation response');

      const contentType = `video/${ext === 'mp4' ? 'mp4' : ext === 'webm' ? 'webm' : ext === 'mov' ? 'quicktime' : 'mp4'}`;
      await uploadFileToS3(s3Url, s3Fields, fileBuffer, contentType);

      const filename = args.file_path.split('/').pop() || 'unknown';
      const finishResult = await sunoClient.POST(`/api/uploads/video/${encodeURIComponent(uploadId)}/upload-finish/`, {
        body: {
          upload_type: 'studio_file_upload',
          upload_filename: filename,
          is_video_cover: args.is_video_cover || false,
          ...(args.clip_id ? { clip_id: args.clip_id } : {}),
        },
      });
      if (!finishResult.ok) throw new Error(finishResult.error || 'Video upload finish failed');

      return { content: [{ type: 'text', text: JSON.stringify({ upload_id: uploadId, status: 'uploaded' }, null, 2) }] };
    }),
  ];

  allTools.push(...tools);
}
