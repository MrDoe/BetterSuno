import { sunoClient } from '../suno-client.js';
import { assertCanCover } from '../auth.js';

function tool(name, description, inputSchema, handler) {
  return { name, description, inputSchema, handler };
}

export function registerGenerationTools(server, allTools) {
  const tools = [
    tool('create_song', 'Generate a song from lyrics and style tags (Custom mode)', {
      type: 'object',
      properties: {
        lyrics: { type: 'string', description: 'Song lyrics with section markers like [Verse], [Chorus]' },
        title: { type: 'string', description: 'Song title' },
        tags: { type: 'string', description: 'Style/genre tags (e.g. "pop, upbeat, synth")' },
        negative_tags: { type: 'string', description: 'Styles to avoid' },
        instrumental: { type: 'boolean', description: 'Make instrumental (no vocals)' },
        mv: { type: 'string', description: 'Model version (chirp-fenix, chirp-v4, chirp-v3-5)', default: 'chirp-fenix' },
        weirdness: { type: 'number', description: 'Weirdness 0-100' },
        style_weight: { type: 'number', description: 'Style influence 0-100' },
        audio_weight: { type: 'number', description: 'Audio influence 0-100' },
        persona_id: { type: 'string', description: 'Persona ID for voice consistency' },
      },
      required: ['lyrics'],
    }, async (args) => {
      const controlSliders = {};
      const canControl = [];
      if (args.weirdness !== undefined) { controlSliders.weirdness_constraint = args.weirdness / 100; canControl.push('weirdness_constraint'); }
      if (args.style_weight !== undefined) { controlSliders.style_weight = args.style_weight / 100; canControl.push('style_weight'); }
      if (args.audio_weight !== undefined) { controlSliders.audio_weight = args.audio_weight / 100; canControl.push('audio_weight'); }

      const payload = {
        mv: args.mv || 'chirp-fenix',
        gpt_description_prompt: '',
        prompt: args.lyrics,
        make_instrumental: args.instrumental || false,
        title: args.title || '',
        tags: args.tags || '',
        negative_tags: args.negative_tags || '',
        generation_type: 'TEXT',
        continue_at: null,
        continue_clip_id: null,
        task: null,
        ...(args.persona_id ? { persona_id: args.persona_id } : {}),
        metadata: {
          web_client_pathname: '/create',
          create_mode: 'custom',
          create_session_token: crypto.randomUUID(),
          ...(Object.keys(controlSliders).length > 0 ? { control_sliders: controlSliders } : {}),
          ...(canControl.length > 0 ? { can_control_sliders: canControl } : {}),
        },
      };

      const result = await sunoClient.generate(payload);
      if (!result.ok) throw new Error(result.error || 'Generation failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('inspire_song', 'Generate a song from a description (Suno auto-writes the lyrics)', {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Style/description text (e.g. "a sad ballad about losing a pet")' },
        title: { type: 'string', description: 'Song title' },
        instrumental: { type: 'boolean', description: 'Make instrumental' },
        mv: { type: 'string', description: 'Model version', default: 'chirp-fenix' },
        tags: { type: 'string', description: 'Additional style tags' },
      },
      required: ['description'],
    }, async (args) => {
      const payload = {
        mv: args.mv || 'chirp-fenix',
        gpt_description_prompt: args.description,
        prompt: '',
        make_instrumental: args.instrumental || false,
        title: args.title || '',
        tags: args.tags || '',
        generation_type: 'TEXT',
        continue_at: null,
        continue_clip_id: null,
        task: null,
        metadata: {
          web_client_pathname: '/create',
          create_mode: 'inspiration',
          create_session_token: crypto.randomUUID(),
        },
      };

      const result = await sunoClient.generate(payload);
      if (!result.ok) throw new Error(result.error || 'Generation failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('cover_song', 'Create a cover version of an existing song', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'ID of the song to cover' },
        start_s: { type: 'number', description: 'Start time in seconds (optional)' },
        end_s: { type: 'number', description: 'End time in seconds (optional)' },
        mv: { type: 'string', description: 'Model version', default: 'chirp-fenix' },
        tags: { type: 'string', description: 'Style tags for the cover' },
        instrumental: { type: 'boolean', description: 'Make instrumental' },
      },
      required: ['clip_id'],
    }, async (args) => {
      await assertCanCover(args.clip_id);
      const payload = {
        mv: args.mv || 'chirp-fenix',
        gpt_description_prompt: '',
        prompt: '',
        make_instrumental: args.instrumental || false,
        title: '',
        tags: args.tags || '',
        generation_type: 'TEXT',
        cover_clip_id: args.clip_id,
        cover_start_s: args.start_s ?? null,
        cover_end_s: args.end_s ?? null,
        continue_at: null,
        continue_clip_id: null,
        task: 'cover',
        metadata: {
          web_client_pathname: '/create',
          create_mode: 'custom',
          create_session_token: crypto.randomUUID(),
        },
      };

      const result = await sunoClient.generate(payload);
      if (!result.ok) throw new Error(result.error || 'Cover generation failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('extend_song', 'Extend a song from a specific point', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'ID of the song to extend' },
        continue_at: { type: 'number', description: 'Time in seconds to extend from' },
        lyrics: { type: 'string', description: 'Optional lyrics for the extension' },
        mv: { type: 'string', description: 'Model version', default: 'chirp-fenix' },
        tags: { type: 'string', description: 'Style tags for the extension' },
      },
      required: ['clip_id', 'continue_at'],
    }, async (args) => {
      await assertCanCover(args.clip_id);
      const payload = {
        mv: args.mv || 'chirp-fenix',
        gpt_description_prompt: '',
        prompt: args.lyrics || '',
        make_instrumental: false,
        title: '',
        tags: args.tags || '',
        generation_type: 'TEXT',
        continue_clip_id: args.clip_id,
        continue_at: args.continue_at,
        cover_clip_id: null,
        task: 'extend',
        metadata: {
          web_client_pathname: '/create',
          create_mode: 'custom',
          create_session_token: crypto.randomUUID(),
        },
      };

      const result = await sunoClient.generate(payload);
      if (!result.ok) throw new Error(result.error || 'Extend failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('mashup_song', 'Blend two or more songs into a mashup', {
      type: 'object',
      properties: {
        clip_ids: { type: 'array', items: { type: 'string' }, description: 'Song clip IDs to blend (2 or more)' },
        title: { type: 'string', description: 'Mashup title' },
        tags: { type: 'string', description: 'Style tags for the mashup' },
        mv: { type: 'string', description: 'Model version', default: 'chirp-fenix' },
      },
      required: ['clip_ids'],
    }, async (args) => {
      if (!Array.isArray(args.clip_ids) || args.clip_ids.length < 2) {
        throw new Error('Provide at least 2 clip IDs to mashup');
      }
      for (const id of args.clip_ids) await assertCanCover(id);
      const payload = {
        mv: args.mv || 'chirp-fenix',
        gpt_description_prompt: '',
        prompt: '',
        make_instrumental: false,
        title: args.title || '',
        tags: args.tags || '',
        generation_type: 'TEXT',
        mashup_clip_ids: args.clip_ids,
        task: 'mashup',
        cover_clip_id: null,
        continue_clip_id: null,
        continue_at: null,
        metadata: {
          web_client_pathname: '/create',
          create_mode: 'custom',
          create_session_token: crypto.randomUUID(),
        },
      };
      const result = await sunoClient.generate(payload);
      if (!result.ok) throw new Error(result.error || 'Mashup generation failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('remaster_song', 'Remaster/upsample a song to higher quality', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'ID of the song to remaster' },
        model_name: { type: 'string', description: 'Target model (optional)' },
        tags: { type: 'string', description: 'Style tags to apply' },
        freedom: { type: 'number', description: 'Variation freedom 0.0-1.0' },
        tone: { type: 'number', description: 'Tone adjustment 0.0-1.0' },
        clarity: { type: 'number', description: 'Clarity 0.0-1.0' },
        strength: { type: 'number', description: 'Strength 0.0-1.0' },
        stereo_width: { type: 'number', description: 'Stereo width 0.0-1.0' },
        variation_category: { type: 'string', description: 'Variation category' },
      },
      required: ['clip_id'],
    }, async (args) => {
      const body = { clip_id: args.clip_id };
      if (args.model_name) body.model_name = args.model_name;
      if (args.tags) body.tags = args.tags;
      if (args.freedom !== undefined) body.freedom = Math.max(0, Math.min(1, args.freedom));
      if (args.tone !== undefined) body.tone = Math.max(0, Math.min(1, args.tone));
      if (args.clarity !== undefined) body.clarity = Math.max(0, Math.min(1, args.clarity));
      if (args.strength !== undefined) body.strength = Math.max(0, Math.min(1, args.strength));
      if (args.stereo_width !== undefined) body.stereo_width = Math.max(0, Math.min(1, args.stereo_width));
      if (args.variation_category) body.variation_category = args.variation_category;

      const result = await sunoClient.POST('/api/generate/upsample', { body });
      if (!result.ok) throw new Error(result.error || 'Remaster failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('make_stems', 'Extract stems (vocals, instrumental, drums, bass) from a song', {
      type: 'object',
      properties: {
        clip_id: { type: 'string', description: 'ID of the song to extract stems from' },
      },
      required: ['clip_id'],
    }, async (args) => {
      const result = await sunoClient.POST(`/api/edit/stems/${encodeURIComponent(args.clip_id)}/`);
      if (!result.ok) throw new Error(result.error || 'Stem extraction failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('get_recommended_styles', 'Get recommended style tags for inspiration', {
      type: 'object',
      properties: {},
    }, async () => {
      const result = await sunoClient.GET('/api/generate/get_recommend_styles');
      if (!result.ok) throw new Error(result.error || 'Failed to fetch styles');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),

    tool('upsample_tags', 'Expand and enhance style tags with AI suggestions', {
      type: 'object',
      properties: {
        tags: { type: 'string', description: 'Base style tags to expand' },
      },
      required: ['tags'],
    }, async (args) => {
      const result = await sunoClient.POST('/api/prompts/upsample', { body: { prompt: args.tags } });
      if (!result.ok) throw new Error(result.error || 'Tag upsample failed');
      return { content: [{ type: 'text', text: JSON.stringify(result.data, null, 2) }] };
    }),
  ];

  allTools.push(...tools);
}
