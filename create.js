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
    loadPersonas();
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
          <label class="create-label ml-5" for="create-model">Model</label>
          <select id="create-model" class="create-select">
            <option value="chirp-fenix">v5.5</option>
            <option value="chirp-crow">v5.0</option>
            <option value="chirp-bluejay">v4.5+</option>
          </select>
          </div>
        </div>

        <div class="create-section">
          <label class="create-label">Voice</label>
          <button id="create-persona-btn" class="create-persona-btn" type="button">
            <span id="create-persona-label">-- None --</span>
          </button>
          <input type="hidden" id="create-persona" value="" />
          <input type="hidden" id="create-persona-model" value="" />
        </div>

        <div class="create-section">
          <label class="create-label" for="create-title">Song Title</label>
          <input type="text" id="create-title" class="create-input" placeholder="My Song" maxlength="200" inputmode="text" autocomplete="off" />
        </div>

        <div class="create-section">
          <label class="create-label" for="create-lyrics">Lyrics</label>
          <textarea id="create-lyrics" class="create-textarea" placeholder="[Verse]\nYour lyrics here...\n\n[Chorus]\nMore lyrics..." rows="10" maxlength="5000"></textarea>
        </div>

        <div class="create-section">
          <label class="create-label" for="create-style">Music Style</label>
          <textarea id="create-style" class="create-textarea" placeholder="e.g., upbeat pop with synth and female vocals" maxlength="1000" inputmode="text" autocomplete="off"></textarea>
        </div>

        <div class="create-section">
          <label class="create-label" for="create-exclude">Exclude Style</label>
          <input type="text" id="create-exclude" class="create-input" placeholder="e.g., heavy metal, opera" maxlength="1000" inputmode="text" autocomplete="off" />
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

      <div id="persona-dialog-overlay" class="persona-dialog-overlay" style="display:none;">
        <div class="persona-dialog">
          <div class="persona-dialog-header">
            <span class="persona-dialog-title">Select Voice</span>
            <button id="persona-dialog-close" class="persona-dialog-close" type="button">&times;</button>
          </div>
          <div class="persona-dialog-body">
            <div id="persona-dialog-grid" class="persona-grid"></div>
            <div id="persona-dialog-loading" class="persona-dialog-loading" style="display:none;">Loading...</div>
          </div>
          <div class="persona-dialog-footer">
            <button id="persona-dialog-none" class="persona-dialog-none-btn" type="button">None (no voice)</button>
            <button id="persona-dialog-more" class="persona-dialog-more-btn" type="button" style="display:none;">Load more...</button>
          </div>
        </div>
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

    // Persona dialog
    var personaDialogOverlay = document.getElementById('persona-dialog-overlay');
    document.getElementById('create-persona-btn').addEventListener('click', openPersonaDialog);
    document.getElementById('persona-dialog-close').addEventListener('click', closePersonaDialog);
    document.getElementById('persona-dialog-none').addEventListener('click', selectNoPersona);
    document.getElementById('persona-dialog-more').addEventListener('click', loadMorePersonas);
    personaDialogOverlay.addEventListener('click', function(e) {
      if (e.target === personaDialogOverlay) closePersonaDialog();
    });
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
      audioInfluence: parseInt(document.getElementById('create-audio-influence').value),
      personaId: document.getElementById('create-persona').value,
      personaModel: document.getElementById('create-persona-model').value || undefined
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
    if (data.personaId !== undefined) {
      document.getElementById('create-persona').value = data.personaId || '';
      document.getElementById('create-persona-model').value = data.personaModel || '';
      personaState.selectedId = data.personaId || '';
      personaState.selectedName = data.personaName || data.personaId || '';
      personaState.selectedModel = data.personaModel || '';
      updatePersonaDisplay();
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

  // Persona dialog state
  var personaState = {
    personas: [],
    continuationToken: null,
    hasMore: false,
    loading: false,
    selectedId: '',
    selectedName: '',
    selectedModel: ''
  };

  function openPersonaDialog() {
    document.getElementById('persona-dialog-overlay').style.display = 'flex';
    // Load page 1 if no personas loaded yet
    if (personaState.personas.length === 0 && !personaState.loading) {
      loadPersonasPage(1, null);
    }
  }

  function closePersonaDialog() {
    document.getElementById('persona-dialog-overlay').style.display = 'none';
  }

  function selectPersona(id, name, model) {
    personaState.selectedId = id;
    personaState.selectedName = name;
    personaState.selectedModel = model || 'style_persona';
    document.getElementById('create-persona').value = id;
    document.getElementById('create-persona-model').value = model || 'style_persona';
    updatePersonaDisplay();
    closePersonaDialog();
    // Highlight selected card
    var cards = document.querySelectorAll('.persona-card');
    cards.forEach(function(c) { c.classList.remove('persona-card-selected'); });
    var selected = document.getElementById('persona-card-' + id);
    if (selected) selected.classList.add('persona-card-selected');
  }

  function selectNoPersona() {
    personaState.selectedId = '';
    personaState.selectedName = '';
    personaState.selectedModel = '';
    document.getElementById('create-persona').value = '';
    document.getElementById('create-persona-model').value = '';
    updatePersonaDisplay();
    closePersonaDialog();
    var cards = document.querySelectorAll('.persona-card');
    cards.forEach(function(c) { c.classList.remove('persona-card-selected'); });
  }

  function updatePersonaDisplay() {
    var label = document.getElementById('create-persona-label');
    if (personaState.selectedId && personaState.selectedName) {
      label.textContent = personaState.selectedName + (personaState.selectedModel === 'voice_persona' ? ' (Voice)' : '');
    } else {
      label.textContent = '-- None --';
    }
  }

  function loadPersonas() {
    // Initial load: fetch page 1
    loadPersonasPage(1, null);
  }

  function loadPersonasPage(page, continuationToken) {
    if (personaState.loading) return;
    personaState.loading = true;

    var loadingEl = document.getElementById('persona-dialog-loading');
    if (loadingEl) loadingEl.style.display = 'block';

    api.runtime.sendMessage({
      action: 'fetch_personas',
      page: page,
      continuationToken: continuationToken || undefined
    }, function(response) {
      personaState.loading = false;
      if (loadingEl) loadingEl.style.display = 'none';

      if (!response || !response.ok) return;

      var newPersonas = response.personas || [];
      if (page === 1) personaState.personas = [];
      personaState.personas = personaState.personas.concat(newPersonas);
      personaState.continuationToken = response.continuation_token || null;
      personaState.hasMore = response.has_more || false;

      renderPersonaCards(newPersonas);

      var moreBtn = document.getElementById('persona-dialog-more');
      if (moreBtn) moreBtn.style.display = personaState.hasMore ? 'block' : 'none';

      // Re-highlight if selected
      if (personaState.selectedId) {
        var sel = document.getElementById('persona-card-' + personaState.selectedId);
        if (sel) sel.classList.add('persona-card-selected');
      }

      // Re-apply selected prompt's persona (race condition fix)
      if (page === 1) {
        var promptSelect = document.getElementById('create-prompt-select');
        if (promptSelect && promptSelect.value) {
          loadPromptIntoForm(promptSelect.value);
        }
      }
    });
  }

  function loadMorePersonas() {
    if (!personaState.hasMore || personaState.loading) return;
    loadPersonasPage(0, personaState.continuationToken);
  }

  function renderPersonaCards(personas) {
    var grid = document.getElementById('persona-dialog-grid');
    if (!grid) return;

    personas.forEach(function(p) {
      var card = document.createElement('div');
      card.className = 'persona-card';
      card.id = 'persona-card-' + p.id;
      card.title = p.name;
      card.setAttribute('data-persona-id', p.id);
      card.setAttribute('data-persona-model', p.is_vox_persona ? 'voice_persona' : 'style_persona');

      if (p.image_url) {
        var img = document.createElement('img');
        img.className = 'persona-card-img';
        img.src = p.image_url;
        img.alt = p.name;
        img.loading = 'lazy';
        card.appendChild(img);
      } else {
        var placeholder = document.createElement('div');
        placeholder.className = 'persona-card-noimg';
        placeholder.textContent = p.name.charAt(0);
        card.appendChild(placeholder);
      }

      var nameEl = document.createElement('span');
      nameEl.className = 'persona-card-name';
      nameEl.textContent = p.name;
      card.appendChild(nameEl);

      if (p.is_vox_persona) {
        var badge = document.createElement('span');
        badge.className = 'persona-card-badge';
        badge.textContent = 'V';
        card.appendChild(badge);
      }

      card.addEventListener('click', function() {
        selectPersona(
          card.getAttribute('data-persona-id'),
          p.name,
          card.getAttribute('data-persona-model')
        );
      });

      if (p.id === personaState.selectedId) {
        card.classList.add('persona-card-selected');
      }

      grid.appendChild(card);
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
        audioInfluence: prompt.audioInfluence,
        personaId: prompt.personaId,
        personaModel: prompt.personaModel,
        personaName: prompt.personaName || ''
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
      personaId: data.personaId,
      personaModel: data.personaModel,
      personaName: personaState.selectedName,
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
      audioInfluence: data.audioInfluence,
      personaId: data.personaId || undefined,
      personaModel: data.personaModel || undefined
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
    loadPersonas();
  });

  // Start initialization
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
