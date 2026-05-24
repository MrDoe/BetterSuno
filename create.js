// create.js — Custom song creation tab for BetterSuno
(function () {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;

  // Wait for content.js to inject the DOM
  function init() {
    const container = document.getElementById('bettersuno-create-content');
    if (!container) {
      setTimeout(init, 100);
      return;
    }

    // Only inject once
    if (container.querySelector('#create-form-container')) return;

    buildUI(container);
    loadPrompts();
  }

  function buildUI(container) {
    container.innerHTML = `
      <div id="create-form-container">
        <div class="create-section">
          <label class="create-label">Saved Prompt</label>
          <div class="create-prompt-row">
            <select id="create-prompt-select" class="create-select">
              <option value="">-- Select a saved prompt --</option>
            </select>
            <button id="create-delete-prompt-btn" class="btn-danger create-small-btn" title="Delete selected prompt" type="button" disabled>🗑</button>
          </div>
        </div>

        <div class="create-section">
          <label class="create-label" for="create-model">Model</label>
          <select id="create-model" class="create-select">
            <option value="chirp-fenix">v5.5</option>
            <option value="chirp-crow">v5.0</option>
            <option value="chirp-bluejay">v4.5+</option>
          </select>
        </div>

        <div class="create-section">
          <label class="create-label" for="create-title">Song Title</label>
          <input type="text" id="create-title" class="create-input" placeholder="My Song" maxlength="200" />
        </div>

        <div class="create-section">
          <label class="create-label" for="create-style">Music Style</label>
          <input type="text" id="create-style" class="create-input" placeholder="e.g., upbeat pop with synth and female vocals" maxlength="200" />
        </div>

        <div class="create-section">
          <label class="create-label" for="create-exclude">Exclude Style</label>
          <input type="text" id="create-exclude" class="create-input" placeholder="e.g., heavy metal, opera" maxlength="200" />
        </div>

        <div class="create-section">
          <label class="create-label" for="create-lyrics">Lyrics</label>
          <textarea id="create-lyrics" class="create-textarea" placeholder="[Verse]\nYour lyrics here...\n\n[Chorus]\nMore lyrics..." rows="8" maxlength="5000"></textarea>
        </div>

        <div class="create-section">
          <label class="create-label create-toggle-label">
            <input type="checkbox" id="create-instrumental" />
            <span>Instrumental</span>
          </label>
        </div>

        <div class="create-section">
          <label class="create-label">Weirdness: <span id="create-weirdness-value">50</span>%</label>
          <input type="range" id="create-weirdness" class="create-range" min="0" max="100" value="50" />
        </div>

        <div class="create-section">
          <label class="create-label">Music Style Influence: <span id="create-style-influence-value">50</span>%</label>
          <input type="range" id="create-style-influence" class="create-range" min="0" max="100" value="50" />
        </div>

        <div class="create-section">
          <label class="create-label">Audio Influence (Persona/Voice): <span id="create-audio-influence-value">50</span>%</label>
          <input type="range" id="create-audio-influence" class="create-range" min="0" max="100" value="50" />
        </div>

        <div class="create-actions">
          <button id="create-generate-btn" class="btn-primary" type="button">🎵 Generate</button>
          <button id="create-save-btn" class="btn-secondary" type="button">💾 Save Prompt</button>
        </div>

        <div id="create-status"></div>
      </div>
    `;

    wireEvents();
  }

  function wireEvents() {
    // Slider value displays
    document.getElementById('create-weirdness').addEventListener('input', function() {
      document.getElementById('create-weirdness-value').textContent = this.value;
    });
    document.getElementById('create-style-influence').addEventListener('input', function() {
      document.getElementById('create-style-influence-value').textContent = this.value;
    });
    document.getElementById('create-audio-influence').addEventListener('input', function() {
      document.getElementById('create-audio-influence-value').textContent = this.value;
    });

    // Prompt dropdown selection
    document.getElementById('create-prompt-select').addEventListener('change', function() {
      const id = this.value;
      const deleteBtn = document.getElementById('create-delete-prompt-btn');
      if (!id) {
        deleteBtn.disabled = true;
        return;
      }
      deleteBtn.disabled = false;
      loadPromptIntoForm(id);
    });

    // Delete prompt
    document.getElementById('create-delete-prompt-btn').addEventListener('click', function() {
      const select = document.getElementById('create-prompt-select');
      const id = select.value;
      if (!id) return;
      if (!confirm('Delete this saved prompt?')) return;
      api.runtime.sendMessage({ action: 'delete_prompt', id }, function(response) {
        if (response && response.ok) {
          select.value = '';
          this.disabled = true;
          loadPrompts();
        }
      }.bind(this));
    });

    // Generate button
    document.getElementById('create-generate-btn').addEventListener('click', generateSong);

    // Save prompt button
    document.getElementById('create-save-btn').addEventListener('click', saveCurrentPrompt);
  }

  function getFormData() {
    return {
      model: document.getElementById('create-model').value,
      title: document.getElementById('create-title').value.trim(),
      stylePrompt: document.getElementById('create-style').value.trim(),
      excludeStyle: document.getElementById('create-exclude').value.trim(),
      lyrics: document.getElementById('create-lyrics').value.trim(),
      instrumental: document.getElementById('create-instrumental').checked,
      weirdness: parseInt(document.getElementById('create-weirdness').value),
      styleInfluence: parseInt(document.getElementById('create-style-influence').value),
      audioInfluence: parseInt(document.getElementById('create-audio-influence').value)
    };
  }

  function setFormData(data) {
    if (data.model) document.getElementById('create-model').value = data.model;
    if (data.title !== undefined) document.getElementById('create-title').value = data.title || '';
    if (data.stylePrompt !== undefined) document.getElementById('create-style').value = data.stylePrompt || '';
    if (data.excludeStyle !== undefined) document.getElementById('create-exclude').value = data.excludeStyle || '';
    if (data.lyrics !== undefined) document.getElementById('create-lyrics').value = data.lyrics || '';
    if (data.instrumental !== undefined) document.getElementById('create-instrumental').checked = data.instrumental;
    if (data.weirdness !== undefined) {
      document.getElementById('create-weirdness').value = data.weirdness;
      document.getElementById('create-weirdness-value').textContent = data.weirdness;
    }
    if (data.styleInfluence !== undefined) {
      document.getElementById('create-style-influence').value = data.styleInfluence;
      document.getElementById('create-style-influence-value').textContent = data.styleInfluence;
    }
    if (data.audioInfluence !== undefined) {
      document.getElementById('create-audio-influence').value = data.audioInfluence;
      document.getElementById('create-audio-influence-value').textContent = data.audioInfluence;
    }
  }

  function loadPrompts() {
    api.runtime.sendMessage({ action: 'get_prompts' }, function(response) {
      if (!response || !response.ok) return;
      const prompts = response.prompts || [];
      const select = document.getElementById('create-prompt-select');
      // Clear all options except the first (placeholder)
      while (select.options.length > 1) select.remove(1);
      
      prompts.forEach(function(p) {
        const option = document.createElement('option');
        option.value = p.id;
        option.textContent = p.name || p.title || 'Untitled';
        select.appendChild(option);
      });
    });
  }

  function loadPromptIntoForm(id) {
    api.runtime.sendMessage({ action: 'get_prompts' }, function(response) {
      if (!response || !response.ok) return;
      const prompts = response.prompts || [];
      const prompt = prompts.find(function(p) { return p.id === id; });
      if (!prompt) return;
      setFormData({
        model: prompt.model,
        title: prompt.name || prompt.sourceSongTitle || '',
        stylePrompt: prompt.stylePrompt,
        excludeStyle: prompt.excludeStyle,
        lyrics: prompt.lyrics,
        instrumental: prompt.instrumental,
        weirdness: prompt.weirdness,
        styleInfluence: prompt.styleInfluence,
        audioInfluence: prompt.audioInfluence
      });
    });
  }

  function saveCurrentPrompt() {
    const data = getFormData();
    const name = data.title || 'Untitled Prompt';
    
    const prompt = {
      id: 'prompt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      name: name,
      stylePrompt: data.stylePrompt,
      lyrics: data.lyrics,
      instrumental: data.instrumental,
      excludeStyle: data.excludeStyle,
      weirdness: data.weirdness,
      styleInfluence: data.styleInfluence,
      audioInfluence: data.audioInfluence,
      model: data.model,
      sourceSongId: null,
      sourceSongTitle: name,
      tags: [],
      rating: 0,
      savedAt: Date.now(),
      updatedAt: Date.now()
    };

    api.runtime.sendMessage({ action: 'save_prompt', prompt: prompt }, function(response) {
      if (response && response.ok) {
        showStatus('Prompt saved!', 'success');
        loadPrompts();
      } else {
        showStatus('Failed to save prompt', 'error');
      }
    });
  }

  function generateSong() {
    var data = getFormData();
    var btn = document.getElementById('create-generate-btn');
    var status = document.getElementById('create-status');
    
    if (!data.lyrics) {
      showStatus('Please enter lyrics', 'error');
      return;
    }

    btn.disabled = true;
    btn.textContent = '⏳ Generating...';
    status.innerHTML = '';

    api.runtime.sendMessage({
      action: 'generate_song',
      mv: data.model,
      title: data.title || undefined,
      stylePrompt: data.stylePrompt,
      lyrics: data.lyrics,
      instrumental: data.instrumental,
      negativeTags: data.excludeStyle || undefined,
      tags: undefined,
      weirdness: data.weirdness,
      styleInfluence: data.styleInfluence,
      audioInfluence: data.audioInfluence
    }, function(response) {
      btn.disabled = false;
      btn.textContent = '🎵 Generate';

      if (!response) {
        showStatus('No response from background script', 'error');
        return;
      }

      if (!response.ok) {
        showStatus('Generation failed: ' + (response.error || 'Unknown error'), 'error');
        return;
      }

      var clips = response.data && response.data.clips;
      if (clips && clips.length > 0) {
        var clipIds = clips.map(function(c) { return c.id; }).join(', ');
        showStatus('Generated! Clip IDs: ' + clipIds + '. Check your Suno library.', 'success');
      } else {
        showStatus('Generation submitted. Check your Suno library.', 'success');
      }
    });
  }

  function showStatus(message, type) {
    var status = document.getElementById('create-status');
    if (!status) return;
    status.textContent = message;
    status.className = 'create-status-' + (type || 'info');
    
    if (type === 'success') {
      setTimeout(function() {
        if (status.textContent === message) {
          status.textContent = '';
          status.className = '';
        }
      }, 5000);
    }
  }

  // Listen for tab opened event from content.js
  document.addEventListener('bettersuno:create-tab-opened', function() {
    loadPrompts();
  });

  // Start initialization
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
