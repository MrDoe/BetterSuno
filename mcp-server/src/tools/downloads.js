import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { sunoClient } from '../suno-client.js';
import { getToken } from '../ws-bridge.js';
import { assertOwned } from '../auth.js';

function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').trim() || 'untitled';
}

async function ensureDir(dir) {
  try {
    await mkdir(dir, { recursive: true });
  } catch {}
}

export function registerDownloadTools(server, allTools) {
  const tools = [
    tool('get_song_urls', 'Get all downloadable URLs for a song', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'Song clip ID' },
      },
      required: ['clip_id'],
    }, async (args) => {
      const s = await assertOwned(args.clip_id);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            id: s.id,
            title: s.title,
            audio_url: s.audio_url,
            image_url: s.image_url,
            video_url: s.video_url,
            video_cover_url: s.metadata?.video_cover_url,
            lyrics: s.metadata?.prompt || s.lyrics,
            has_wav: !!s.metadata?.wav_file_url,
            owner_handle: s.user?.username || s.metadata?.user?.username,
          }, null, 2),
        }],
      };
    }),

    tool('download_song', 'Download a song\'s audio to disk', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'Song clip ID' },
        format: { type: 'string', enum: ['m4a', 'wav'], description: 'Audio format', default: 'm4a' },
        output_dir: { type: 'string', description: 'Output directory (defaults to current dir)' },
      },
      required: ['clip_id'],
    }, async (args) => {
      const song = await assertOwned(args.clip_id);
      let audioUrl = song.audio_url;
      if (args.format === 'wav' && song.metadata?.wav_file_url) {
        audioUrl = song.metadata.wav_file_url;
      }
      if (!audioUrl) throw new Error('No audio URL available for this song');

      const response = await fetch(audioUrl, {
        headers: { 'Authorization': `Bearer ${getToken()}` },
      });
      if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);

      const buffer = Buffer.from(await response.arrayBuffer());
      const title = sanitizeFilename(song.title || `song_${args.clip_id.slice(-4)}`);
      const ext = args.format === 'wav' ? 'wav' : 'm4a';
      const filename = `${title}_${args.clip_id.slice(-4)}.${ext}`;
      const outputDir = args.output_dir ? resolve(args.output_dir) : process.cwd();
      await ensureDir(outputDir);
      const filePath = join(outputDir, filename);
      await writeFile(filePath, buffer);

      return { content: [{ type: 'text', text: `Downloaded to ${filePath} (${buffer.length} bytes)` }] };
    }),

    tool('download_lyrics', 'Download a song\'s lyrics as a text file', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'Song clip ID' },
        output_dir: { type: 'string', description: 'Output directory (defaults to current dir)' },
      },
      required: ['clip_id'],
    }, async (args) => {
      const song = await assertOwned(args.clip_id);
      const lyrics = song.metadata?.prompt || song.lyrics;
      if (!lyrics) throw new Error('No lyrics available for this song');

      const title = sanitizeFilename(song.title || `song_${args.clip_id.slice(-4)}`);
      const filename = `${title}_${args.clip_id.slice(-4)}.txt`;
      const outputDir = args.output_dir ? resolve(args.output_dir) : process.cwd();
      await ensureDir(outputDir);
      const filePath = join(outputDir, filename);
      await writeFile(filePath, lyrics, 'utf-8');

      return { content: [{ type: 'text', text: `Lyrics saved to ${filePath}` }] };
    }),

    tool('download_cover_image', 'Download a song\'s cover image', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'Song clip ID' },
        output_dir: { type: 'string', description: 'Output directory (defaults to current dir)' },
      },
      required: ['clip_id'],
    }, async (args) => {
      const song = await assertOwned(args.clip_id);
      let imageUrl = song.image_url || song.metadata?.image_url;
      if (!imageUrl) throw new Error('No cover image available for this song');

      const response = await fetch(imageUrl);
      if (!response.ok) throw new Error(`Image download failed: HTTP ${response.status}`);

      const buffer = Buffer.from(await response.arrayBuffer());
      const ext = (imageUrl.split('?')[0].match(/\.([a-z0-9]{2,5})$/i)?.[1] || 'jpg').toLowerCase();
      const title = sanitizeFilename(song.title || `song_${args.clip_id.slice(-4)}`);
      const filename = `${title}_${args.clip_id.slice(-4)}.${ext}`;
      const outputDir = args.output_dir ? resolve(args.output_dir) : process.cwd();
      await ensureDir(outputDir);
      const filePath = join(outputDir, filename);
      await writeFile(filePath, buffer);

      return { content: [{ type: 'text', text: `Cover image saved to ${filePath} (${buffer.length} bytes)` }] };
    }),
  ];

  allTools.push(...tools);
}
