// ─── Plataforma de Aprendizagem - Frontend ────────────────
// SPA com seleção de cursos, geração LLM e explicações de quiz

// ─── Client-side API-key encryption helpers (Web Crypto API) ──
// The API key never leaves the browser unencrypted. It is stored in
// localStorage as an AES-GCM ciphertext, protected by a user-chosen PIN.
// The decrypted key is only held in memory and sent per-request via the
// X-LLM-Key header over HTTPS.
const KeyVault = {
  _PBKDF2_ITERATIONS: 600000,

  // Derive a 256-bit AES-GCM key from a PIN + salt using PBKDF2
  async _deriveKey(pin, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: this._PBKDF2_ITERATIONS, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  },

  // Encrypt plaintext → { salt, iv, ciphertext } (all base64)
  async encrypt(plaintext, pin) {
    const enc = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv   = crypto.getRandomValues(new Uint8Array(12));
    const key  = await this._deriveKey(pin, salt);
    const ct   = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, enc.encode(plaintext)
    );
    return {
      salt:       this._toBase64(salt),
      iv:         this._toBase64(iv),
      ciphertext: this._toBase64(new Uint8Array(ct)),
    };
  },

  // Decrypt { salt, iv, ciphertext } → plaintext string
  async decrypt(blob, pin) {
    const salt = this._fromBase64(blob.salt);
    const iv   = this._fromBase64(blob.iv);
    const ct   = this._fromBase64(blob.ciphertext);
    const key  = await this._deriveKey(pin, salt);
    const pt   = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
  },

  // localStorage helpers — keyed per account
  _storageKey(accountId) { return `llmKey_${accountId}`; },

  save(accountId, encryptedBlob) {
    localStorage.setItem(this._storageKey(accountId), JSON.stringify(encryptedBlob));
  },
  load(accountId) {
    const raw = localStorage.getItem(this._storageKey(accountId));
    return raw ? JSON.parse(raw) : null;
  },
  remove(accountId) {
    localStorage.removeItem(this._storageKey(accountId));
  },
  has(accountId) {
    return localStorage.getItem(this._storageKey(accountId)) !== null;
  },

  // Base64 encode/decode
  _toBase64(buf)  { return btoa(String.fromCharCode(...buf)); },
  _fromBase64(s)  { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); },
};

const App = {
  // Account (Google OAuth identity)
  accountId: null,
  accountName: null,
  accountPicture: null,
  // Active profile (learning profile)
  userId: null,
  userName: null,
  userAvatar: null,
  userPicture: null,
  userAuthProvider: 'local',
  googleClientId: null,
  googleEnabled: false,
  googleScriptPromise: null,
  currentView: 'users',
  courses: [],
  currentCourse: null,
  modules: [],
  currentModule: null,
  currentLesson: null,
  quizState: null,
  vocabIndex: 0,
  // Decrypted API key held in memory for the current session only
  _llmApiKey: null,

  // ─── Inicializar ─────────────────────────────────────────
  async init() {
    await this.loadAuthConfig();

    try {
      const session = await this.api('/api/auth/session');
      if (session.account) {
        this.setCurrentAccount(session.account);
      }
      if (session.user) {
        this.setCurrentUser(session.user);
      }
      // If there is an encrypted API key stored locally, prompt for PIN
      if (this.hasStoredApiKey()) {
        await this.ensureApiKeyUnlocked();
      }
      if (session.needsProfileSelection) {
        this.showProfileSelection();
        return;
      }
      if (session.user) {
        this.showCourseSelection();
        return;
      }
    } catch (e) {
      console.error('Sessão anterior não restaurada:', e.message);
    }

    this.showUserSelection();
  },

  // ─── API Helper ──────────────────────────────────────────
  async api(url, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    // Attach decrypted API key if available (never stored server-side)
    if (this._llmApiKey) {
      headers['X-LLM-Key'] = this._llmApiKey;
    }
    const res = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Pedido falhou' }));
      throw new Error(err.error || 'Pedido falhou');
    }
    return res.json();
  },

  escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  setCurrentUser(user) {
    this.userId = user.id;
    this.userName = user.name;
    this.userAvatar = user.avatar;
    this.userPicture = user.picture || null;
    this.userAuthProvider = user.authProvider || 'local';
  },

  setCurrentAccount(account) {
    this.accountId = account.id;
    this.accountName = account.name;
    this.accountPicture = account.picture || null;
    this._llmApiKey = null; // reset on account switch
  },

  clearCurrentUser() {
    this.userId = null;
    this.userName = null;
    this.userAvatar = null;
    this.userPicture = null;
    this.userAuthProvider = 'local';
  },

  clearCurrentAccount() {
    this.accountId = null;
    this.accountName = null;
    this.accountPicture = null;
    this._llmApiKey = null;
  },

  // ─── API Key Vault helpers ──────────────────────────────
  // Check whether this account has an encrypted key in localStorage
  hasStoredApiKey() {
    return this.accountId && KeyVault.has(this.accountId);
  },

  // Show a modal PIN prompt; resolves with the entered PIN or null if cancelled
  _promptPin(message) {
    return new Promise(resolve => {
      // Remove any existing overlay
      const old = document.getElementById('pin-overlay');
      if (old) old.remove();

      const overlay = document.createElement('div');
      overlay.id = 'pin-overlay';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:9999';
      overlay.innerHTML = `
        <div style="background:var(--card-bg,#fff);border-radius:12px;padding:24px;max-width:360px;width:90%;box-shadow:0 4px 20px rgba(0,0,0,.3)">
          <h3 style="margin:0 0 8px">🔐 PIN da Chave API</h3>
          <p style="margin:0 0 16px;font-size:.9em;color:var(--text-muted,#666)">${message}</p>
          <input id="pin-input" type="password" inputmode="text" placeholder="Insere o teu PIN..."
                 style="width:100%;padding:10px;border:1px solid var(--border,#ccc);border-radius:8px;font-size:1em;box-sizing:border-box;margin-bottom:12px">
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button id="pin-cancel" style="padding:8px 16px;border:none;border-radius:8px;cursor:pointer;background:var(--bg-muted,#eee)">Cancelar</button>
            <button id="pin-ok" style="padding:8px 16px;border:none;border-radius:8px;cursor:pointer;background:var(--primary,#4f8cff);color:#fff;font-weight:600">Desbloquear</button>
          </div>
          <p id="pin-error" style="color:#e74c3c;font-size:.85em;margin:8px 0 0;display:none"></p>
        </div>`;
      document.body.appendChild(overlay);

      const input = document.getElementById('pin-input');
      const okBtn = document.getElementById('pin-ok');
      const cancelBtn = document.getElementById('pin-cancel');

      const cleanup = (val) => { overlay.remove(); resolve(val); };
      cancelBtn.onclick = () => cleanup(null);
      okBtn.onclick = () => cleanup(input.value);
      input.addEventListener('keydown', e => { if (e.key === 'Enter') cleanup(input.value); });
      input.focus();
    });
  },

  // Prompt the user for their PIN and unlock the stored key
  async unlockApiKey() {
    if (!this.accountId || !KeyVault.has(this.accountId)) return false;
    const pin = await this._promptPin('Insere o PIN para desbloquear a tua chave API.');
    if (!pin) return false;
    try {
      const blob = KeyVault.load(this.accountId);
      this._llmApiKey = await KeyVault.decrypt(blob, pin);
      return true;
    } catch {
      alert('❌ PIN incorreto. Tenta novamente nas definições LLM.');
      return false;
    }
  },

  // Ensure the API key is unlocked; returns true if ready, false if not
  async ensureApiKeyUnlocked() {
    if (this._llmApiKey) return true;
    if (!this.hasStoredApiKey()) return true; // no key configured, server default will be used
    return this.unlockApiKey();
  },

  currentUserProfile() {
    return {
      name: this.userName,
      avatar: this.userAvatar,
      picture: this.userPicture,
    };
  },

  renderAvatar(user, className = 'avatar') {
    const picture = user?.picture || null;
    const safeName = this.escapeHtml(user?.name || 'Utilizador');
    if (picture) {
      return `<img class="${className} avatar-image" src="${this.escapeHtml(picture)}" alt="${safeName}">`;
    }
    return `<span class="${className}">${this.escapeHtml(user?.avatar || '🧒')}</span>`;
  },

  async loadAuthConfig() {
    try {
      const authConfig = await this.api('/api/auth/config');
      this.googleEnabled = Boolean(authConfig.googleEnabled && authConfig.googleClientId);
      this.googleClientId = authConfig.googleClientId || null;

      if (this.googleEnabled) {
        await this.loadGoogleScript();
        this.initializeGoogleLogin();
      }
    } catch (err) {
      console.error('Falha ao carregar configuração de autenticação:', err.message);
    }
  },

  loadGoogleScript() {
    if (window.google?.accounts?.id) return Promise.resolve();
    if (this.googleScriptPromise) return this.googleScriptPromise;

    this.googleScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Falha ao carregar Google Identity Services'));
      document.head.appendChild(script);
    });

    return this.googleScriptPromise;
  },

  initializeGoogleLogin() {
    if (!this.googleEnabled || !window.google?.accounts?.id) return;

    window.google.accounts.id.initialize({
      client_id: this.googleClientId,
      callback: (response) => this.handleGoogleCredential(response),
      auto_select: false,
      cancel_on_tap_outside: true,
    });
  },

  renderGoogleButton() {
    if (!this.googleEnabled || !window.google?.accounts?.id) return;
    const container = document.getElementById('googleLoginButton');
    if (!container) return;

    container.innerHTML = '';
    window.google.accounts.id.renderButton(container, {
      theme: 'outline',
      size: 'large',
      shape: 'pill',
      text: 'continue_with',
      locale: 'pt-PT',
      width: 320,
    });
  },

  async handleGoogleCredential(response) {
    if (!response?.credential) return;

    try {
      const result = await this.api('/api/auth/google', {
        method: 'POST',
        body: { credential: response.credential }
      });
      this.setCurrentAccount(result.account);
      this.showProfileSelection(result.profiles || []);
    } catch (err) {
      alert('Não foi possível entrar com Google: ' + err.message);
      this.showUserSelection();
    }
  },

  // ─── Síntese de Voz ─────────────────────────────────────
  speak(text, lang, onEnd) {
    if (!('speechSynthesis' in window)) { if (onEnd) onEnd(); return; }
    // Use course speechLang or default to en-US
    const speechLang = lang || this.currentCourse?.speechLang || 'en-US';
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = speechLang;
    utterance.rate = 0.85;
    utterance.pitch = 1.1;
    const voices = window.speechSynthesis.getVoices();
    const langPrefix = speechLang.split('-')[0];
    const voice = voices.find(v => v.lang.startsWith(langPrefix) && v.name.includes('Female'))
      || voices.find(v => v.lang.startsWith(langPrefix));
    if (voice) utterance.voice = voice;
    if (onEnd) utterance.onend = onEnd;
    window.speechSynthesis.speak(utterance);
  },

  // ─── Render Helper ──────────────────────────────────────
  render(html) {
    document.getElementById('app').innerHTML = html;
  },

  // ─── Efeito Confetti ─────────────────────────────────────
  showConfetti() {
    const container = document.createElement('div');
    container.className = 'confetti-container';
    document.body.appendChild(container);

    const colors = ['#6C63FF', '#FF6584', '#4CAF50', '#FFD700', '#FF9800', '#E91E63'];
    for (let i = 0; i < 60; i++) {
      const piece = document.createElement('div');
      piece.className = 'confetti-piece';
      piece.style.left = Math.random() * 100 + '%';
      piece.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
      piece.style.animationDelay = Math.random() * 1 + 's';
      piece.style.animationDuration = (2 + Math.random() * 2) + 's';
      piece.style.width = (6 + Math.random() * 8) + 'px';
      piece.style.height = (6 + Math.random() * 8) + 'px';
      container.appendChild(piece);
    }
    setTimeout(() => container.remove(), 4000);
  },

  // ─── Ecrã de Carregamento ────────────────────────────────
  showLoading(text = 'A carregar...', subtext = '') {
    this.render(`
      <div class="loading-overlay">
        <div class="loading-spinner"></div>
        <div class="loading-text">${text}</div>
        ${subtext ? `<div class="loading-subtext">${subtext}</div>` : ''}
      </div>
    `);
  },

  // ═══════════════════════════════════════════════════════════
  // SELEÇÃO DE UTILIZADOR
  // ═══════════════════════════════════════════════════════════
  async showUserSelection() {
    this.currentView = 'users';
    this.clearCurrentUser();
    this.clearCurrentAccount();
    this.currentCourse = null;

    let users = [];
    try {
      users = await this.api('/api/users');
    } catch (e) {
      console.error('Falha ao carregar utilizadores:', e);
    }

    // Only show local (non-account) profiles on this screen
    const localUsers = users.filter(u => !u.accountId);

    const usersHtml = localUsers.map(u => `
      <div class="user-card" onclick="App.loginUser(${u.id}, ${u.pin ? 'true' : 'false'})">
        <button class="delete-btn" onclick="event.stopPropagation(); App.deleteUser(${u.id}, '${u.name}')" title="Apagar">🗑️</button>
        <span class="avatar">${u.avatar}</span>
        <div class="name">${u.name}</div>
        <div class="stats">⭐ ${u.totalStars || 0} &nbsp; 🔥 ${u.currentStreak || 0} dias</div>
      </div>
    `).join('');

    const googleSection = this.googleEnabled ? `
      <div class="google-login-section">
        <p class="google-login-label">Entrar com conta Google para gerir perfis</p>
        <div id="googleLoginButton"></div>
      </div>
    ` : '';

    this.render(`
      <div class="user-selection">
        <div class="header">
          <h1>🎓 Plataforma de Aprendizagem</h1>
          <p>Quem vai aprender hoje?</p>
        </div>
        ${googleSection}
        <div class="users-grid">
          ${usersHtml}
          <div class="user-card add-user-card" onclick="App.showCreateUserModal()">
            <span class="plus">+</span>
            <span>Novo Aluno</span>
          </div>
        </div>
      </div>
    `);

    if (this.googleEnabled) {
      setTimeout(() => this.renderGoogleButton(), 100);
    }
  },

  // ═══════════════════════════════════════════════════════════
  // SELEÇÃO DE PERFIL (conta Google)
  // ═══════════════════════════════════════════════════════════
  async showProfileSelection(profiles = null) {
    this.currentView = 'profiles';
    this.clearCurrentUser();
    this.currentCourse = null;

    if (profiles === null) {
      try {
        profiles = await this.api(`/api/accounts/${this.accountId}/profiles`);
      } catch (e) {
        console.error('Falha ao carregar perfis:', e);
        profiles = [];
      }
    }

    const accountPicHtml = this.accountPicture
      ? `<img class="avatar avatar-image" src="${this.escapeHtml(this.accountPicture)}" alt="${this.escapeHtml(this.accountName || '')}">`
      : `<span class="avatar">👤</span>`;

    const profilesHtml = profiles.map(p => `
      <div class="user-card" onclick="App.selectProfile(${p.id}, ${p.hasPin ? 'true' : 'false'})">
        <span class="avatar">${this.escapeHtml(p.avatar || '🧒')}</span>
        <div class="name">${this.escapeHtml(p.name)}</div>
        <div class="stats">⭐ ${p.totalStars || 0} &nbsp; 🔥 ${p.currentStreak || 0} dias</div>
      </div>
    `).join('');

    this.render(`
      <div class="user-selection">
        <div class="header">
          <div class="account-info">
            ${accountPicHtml}
            <div>
              <div class="account-name">${this.escapeHtml(this.accountName || 'Conta Google')}</div>
              <div class="account-actions">
                <button class="btn-link" onclick="App.logoutAccount()">Trocar conta</button>
                <button class="btn-link" onclick="App.showLlmSettings()">⚙️ Config. IA</button>
              </div>
            </div>
          </div>
          <h2>Escolhe o teu perfil</h2>
        </div>
        <div class="users-grid">
          ${profilesHtml}
          <div class="user-card add-user-card" onclick="App.showCreateProfileModal()">
            <span class="plus">+</span>
            <span>Novo Perfil</span>
          </div>
        </div>
      </div>
    `);
  },

  async selectProfile(profileId, hasPin) {
    if (hasPin) {
      this.showProfilePinModal(profileId);
      return;
    }
    try {
      const result = await this.api('/api/auth/select-profile', {
        method: 'POST',
        body: { profileId }
      });
      this.setCurrentUser(result.user);
      this.showCourseSelection();
    } catch (err) {
      alert('Erro: ' + err.message);
    }
  },

  showProfilePinModal(profileId) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = `
      <div class="modal">
        <h2>🔒 Introduz o PIN</h2>
        <div class="pin-input-group">
          <input class="pin-digit" type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" autofocus>
          <input class="pin-digit" type="text" maxlength="1" inputmode="numeric" pattern="[0-9]">
          <input class="pin-digit" type="text" maxlength="1" inputmode="numeric" pattern="[0-9]">
          <input class="pin-digit" type="text" maxlength="1" inputmode="numeric" pattern="[0-9]">
        </div>
        <div class="modal-buttons">
          <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancelar</button>
          <button class="btn btn-primary" onclick="App.submitProfilePin(${profileId})">Entrar</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const digits = overlay.querySelectorAll('.pin-digit');
    digits.forEach((input, i) => {
      input.addEventListener('input', () => {
        if (input.value && i < 3) digits[i + 1].focus();
        if (i === 3 && input.value) this.submitProfilePin(profileId);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !input.value && i > 0) digits[i - 1].focus();
      });
    });
    setTimeout(() => digits[0].focus(), 100);
  },

  async submitProfilePin(profileId) {
    const digits = document.querySelectorAll('.pin-digit');
    const pin = Array.from(digits).map(d => d.value).join('');
    if (pin.length !== 4) return;
    try {
      const result = await this.api('/api/auth/select-profile', {
        method: 'POST',
        body: { profileId, pin }
      });
      this.setCurrentUser(result.user);
      document.querySelector('.modal-overlay')?.remove();
      this.showCourseSelection();
    } catch (err) {
      const pinDigits = document.querySelectorAll('.pin-digit');
      pinDigits.forEach(d => { d.value = ''; d.style.borderColor = 'var(--danger)'; });
      pinDigits[0].focus();
    }
  },

  // ─── Modal Criar Perfil (conta Google) ──────────────────
  showCreateProfileModal() {
    const avatars = ['🧒', '👦', '👧', '🧒🏻', '👦🏻', '👧🏻', '🧒🏽', '👦🏽', '👧🏽', '🧒🏿', '👦🏿', '👧🏿', '🦸', '🧙', '🐱', '🐶'];

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = `
      <div class="modal">
        <h2>👋 Novo Perfil</h2>
        <div class="form-group">
          <label>Nome</label>
          <input type="text" id="newProfileName" placeholder="Escreve o nome..." maxlength="30" autofocus>
        </div>
        <div class="form-group">
          <label>Escolhe o avatar</label>
          <div class="avatar-picker">
            ${avatars.map((a, i) => `
              <button class="avatar-option ${i === 0 ? 'selected' : ''}" data-avatar="${a}" onclick="App.selectAvatar(this)">${a}</button>
            `).join('')}
          </div>
        </div>
        <div class="form-group">
          <label>PIN (opcional)</label>
          <input type="text" id="newProfilePin" placeholder="4 dígitos (opcional)" maxlength="4" inputmode="numeric" pattern="[0-9]*">
        </div>
        <div class="modal-buttons">
          <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancelar</button>
          <button class="btn btn-primary" onclick="App.createProfile()">Criar! 🎉</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    setTimeout(() => document.getElementById('newProfileName')?.focus(), 100);
  },

  async createProfile() {
    const name = document.getElementById('newProfileName')?.value?.trim();
    const avatar = document.querySelector('.avatar-option.selected')?.dataset?.avatar || '🧒';
    const pin = document.getElementById('newProfilePin')?.value?.trim() || null;

    if (!name) {
      document.getElementById('newProfileName').style.borderColor = 'var(--danger)';
      return;
    }

    try {
      await this.api(`/api/accounts/${this.accountId}/profiles`, {
        method: 'POST',
        body: { name, avatar, pin: pin && pin.length === 4 ? pin : null }
      });
      document.querySelector('.modal-overlay')?.remove();
      this.showProfileSelection();
    } catch (err) {
      alert('Erro ao criar perfil: ' + err.message);
    }
  },

  async logoutAccount() {
    await this.api('/api/logout', { method: 'POST' }).catch(() => {});
    this.clearCurrentUser();
    this.clearCurrentAccount();
    if (window.google?.accounts?.id) {
      window.google.accounts.id.disableAutoSelect();
    }
    this.showUserSelection();
  },

  // ─── Modal Criar Utilizador ──────────────────────────────
  showCreateUserModal() {
    const avatars = ['🧒', '👦', '👧', '🧒🏻', '👦🏻', '👧🏻', '🧒🏽', '👦🏽', '👧🏽', '🧒🏿', '👦🏿', '👧🏿', '🦸', '🧙', '🐱', '🐶'];

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = `
      <div class="modal">
        <h2>👋 Novo Aluno</h2>
        <div class="form-group">
          <label>Nome</label>
          <input type="text" id="newUserName" placeholder="Escreve o teu nome..." maxlength="30" autofocus>
        </div>
        <div class="form-group">
          <label>Escolhe o teu avatar</label>
          <div class="avatar-picker">
            ${avatars.map((a, i) => `
              <button class="avatar-option ${i === 0 ? 'selected' : ''}" data-avatar="${a}" onclick="App.selectAvatar(this)">${a}</button>
            `).join('')}
          </div>
        </div>
        <div class="form-group">
          <label>PIN (opcional - para proteger o perfil)</label>
          <input type="text" id="newUserPin" placeholder="4 dígitos (opcional)" maxlength="4" inputmode="numeric" pattern="[0-9]*">
        </div>
        <div class="modal-buttons">
          <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancelar</button>
          <button class="btn btn-primary" onclick="App.createUser()">Criar! 🎉</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    setTimeout(() => document.getElementById('newUserName')?.focus(), 100);
  },

  selectAvatar(el) {
    document.querySelectorAll('.avatar-option').forEach(e => e.classList.remove('selected'));
    el.classList.add('selected');
  },

  async createUser() {
    const name = document.getElementById('newUserName')?.value?.trim();
    const avatar = document.querySelector('.avatar-option.selected')?.dataset?.avatar || '🧒';
    const pin = document.getElementById('newUserPin')?.value?.trim() || null;

    if (!name) {
      document.getElementById('newUserName').style.borderColor = 'var(--danger)';
      return;
    }

    try {
      await this.api('/api/users', {
        method: 'POST',
        body: { name, avatar, pin: pin && pin.length === 4 ? pin : null }
      });
      document.querySelector('.modal-overlay')?.remove();
      this.showUserSelection();
    } catch (err) {
      alert('Erro ao criar utilizador: ' + err.message);
    }
  },

  async deleteUser(id, name) {
    if (!confirm(`Tens a certeza que queres apagar o perfil de "${name}"?\nTodo o progresso será perdido!`)) return;
    try {
      await this.api(`/api/users/${id}`, { method: 'DELETE' });
      this.showUserSelection();
    } catch (err) {
      alert('Erro: ' + err.message);
    }
  },

  // ─── Login ──────────────────────────────────────────────
  async loginUser(id, hasPin) {
    if (hasPin) {
      this.showPinModal(id);
      return;
    }
    try {
      const user = await this.api(`/api/users/${id}/login`, { method: 'POST', body: {} });
      this.userId = user.id;
      this.userName = user.name;
      this.userAvatar = user.avatar;
      this.showCourseSelection();
    } catch (err) {
      alert('Erro: ' + err.message);
    }
  },

  showPinModal(userId) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = `
      <div class="modal">
        <h2>🔒 Introduz o PIN</h2>
        <div class="pin-input-group">
          <input class="pin-digit" type="text" maxlength="1" inputmode="numeric" pattern="[0-9]" autofocus>
          <input class="pin-digit" type="text" maxlength="1" inputmode="numeric" pattern="[0-9]">
          <input class="pin-digit" type="text" maxlength="1" inputmode="numeric" pattern="[0-9]">
          <input class="pin-digit" type="text" maxlength="1" inputmode="numeric" pattern="[0-9]">
        </div>
        <div class="modal-buttons">
          <button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancelar</button>
          <button class="btn btn-primary" onclick="App.submitPin(${userId})">Entrar</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const digits = overlay.querySelectorAll('.pin-digit');
    digits.forEach((input, i) => {
      input.addEventListener('input', () => {
        if (input.value && i < 3) digits[i + 1].focus();
        if (i === 3 && input.value) this.submitPin(userId);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !input.value && i > 0) digits[i - 1].focus();
      });
    });
    setTimeout(() => digits[0].focus(), 100);
  },

  async submitPin(userId) {
    const digits = document.querySelectorAll('.pin-digit');
    const pin = Array.from(digits).map(d => d.value).join('');
    if (pin.length !== 4) return;

    try {
      const user = await this.api(`/api/users/${userId}/login`, { method: 'POST', body: { pin } });
      this.userId = user.id;
      this.userName = user.name;
      this.userAvatar = user.avatar;
      document.querySelector('.modal-overlay')?.remove();
      this.showCourseSelection();
    } catch (err) {
      const pinDigits = document.querySelectorAll('.pin-digit');
      pinDigits.forEach(d => { d.value = ''; d.style.borderColor = 'var(--danger)'; });
      pinDigits[0].focus();
    }
  },

  // ═══════════════════════════════════════════════════════════
  // SELEÇÃO DE CURSO
  // ═══════════════════════════════════════════════════════════
  async showCourseSelection() {
    this.currentView = 'courses';
    this.currentCourse = null;

    let coursesList = [];
    try {
      coursesList = await this.api('/api/courses');
      this.courses = coursesList;
    } catch (e) {
      console.error('Falha ao carregar cursos:', e);
    }

    // Se só houver 1 curso, entrar diretamente
    if (coursesList.length === 1) {
      this.currentCourse = coursesList[0];
      this.showDashboard();
      return;
    }

    const coursesHtml = coursesList.map(c => `
      <div class="course-card" onclick="App.selectCourse('${c.id}')">
        <div class="course-icon">${c.icon || '📚'}</div>
        <div class="course-title">${c.titlePt || c.title}</div>
        <div class="course-desc">${c.descriptionPt || c.description || ''}</div>
        <div class="course-meta">📖 ${c.modulesCount} módulos · ${c.level}</div>
      </div>
    `).join('');

    this.render(`
      <div class="user-selection">
        <div class="top-bar">
          <div class="top-bar-left">
            <div class="user-info">
              <span class="user-avatar">${this.userAvatar}</span>
              <span>${this.userName}</span>
            </div>
          </div>
          <div class="top-bar-right">
            ${this.accountId ? '<button class="btn-icon" onclick="App.showLlmSettings()" title="Configuração LLM">⚙️</button>' : ''}
            <button class="btn-icon" onclick="App.logout()" title="Sair">🚪</button>
          </div>
        </div>
        <div class="header">
          <h1>📚 Escolhe um Curso</h1>
          <p>O que queres aprender hoje?</p>
        </div>
        <div class="courses-grid">
          ${coursesHtml}
        </div>
      </div>
    `);
  },

  async selectCourse(courseId) {
    const course = this.courses.find(c => c.id === courseId);
    if (!course) return;
    this.currentCourse = course;
    this.showDashboard();
  },

  // ═══════════════════════════════════════════════════════════
  // PAINEL PRINCIPAL (DASHBOARD)
  // ═══════════════════════════════════════════════════════════
  async showDashboard() {
    this.currentView = 'dashboard';

    let modules = [], stats = {};
    try {
      [modules, stats] = await Promise.all([
        this.api(`/api/courses/${this.currentCourse.id}/modules?userId=${this.userId}`),
        this.api(`/api/users/${this.userId}/stats`)
      ]);
      this.modules = modules;
    } catch (e) {
      console.error(e);
    }

    const modulesHtml = modules.map(m => `
      <div class="module-card ${m.progress === 100 ? 'completed' : ''}" onclick="App.showModuleLessons('${m.id}')">
        <span class="module-icon">${m.icon || '📖'}</span>
        <div class="module-info">
          <div class="module-title">${m.titlePt || m.title}</div>
          <div class="module-subtitle">${(m.objectives || []).slice(0, 2).join(' · ')}</div>
          <div class="module-meta">
            <span>📖 ${m.completedCount}/${m.lessonsCount} lições</span>
            <span>${m.progress}%</span>
          </div>
          <div class="module-progress-bar">
            <div class="module-progress-fill" style="width: ${m.progress}%"></div>
          </div>
        </div>
        <span class="module-arrow">›</span>
      </div>
    `).join('');

    const courseTitle = this.currentCourse.titlePt || this.currentCourse.title;

    this.render(`
      <div class="dashboard">
        <div class="top-bar">
          <div class="top-bar-left">
            <div class="user-info">
              <span class="user-avatar">${this.userAvatar}</span>
              <span>${this.userName}</span>
            </div>
          </div>
          <div class="top-bar-right">
            <div class="streak-badge">🔥 ${stats.streak?.current_streak || 0}</div>
            <div class="stars-badge">⭐ ${stats.streak?.total_stars || 0}</div>
            <button class="btn-icon" onclick="App.showStats()" title="Estatísticas">📊</button>
            <button class="btn-icon" onclick="App.showVocabReview()" title="Vocabulário">📚</button>
            ${this.accountId ? '<button class="btn-icon" onclick="App.showLlmSettings()" title="Configuração LLM">⚙️</button>' : ''}
            ${this.courses.length > 1 ? '<button class="btn-icon" onclick="App.showCourseSelection()" title="Mudar Curso">🔄</button>' : ''}
            <button class="btn-icon" onclick="App.logout()" title="Sair">🚪</button>
          </div>
        </div>

        <div class="breadcrumb">
          <a onclick="App.showCourseSelection()">Cursos</a> › <strong>${courseTitle}</strong>
        </div>

        <div class="nav-tabs">
          <button class="nav-tab active" onclick="App.showDashboard()">📚 Módulos</button>
          <button class="nav-tab" onclick="App.showStats()">📊 Progresso</button>
          <button class="nav-tab" onclick="App.showVocabReview()">🔤 Vocabulário</button>
        </div>

        <div class="modules-grid">
          ${modulesHtml}
        </div>
      </div>
    `);
  },

  // ─── Terminar Sessão ─────────────────────────────────────
  async logout() {
    await this.api('/api/logout', { method: 'POST' }).catch(() => {});
    document.cookie = 'userId=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
    this.clearCurrentUser();
    this.clearCurrentAccount();
    this.currentCourse = null;
    if (window.google?.accounts?.id) {
      window.google.accounts.id.disableAutoSelect();
    }
    this.showUserSelection();
  },

  // ═══════════════════════════════════════════════════════════
  // LISTA DE LIÇÕES DO MÓDULO
  // ═══════════════════════════════════════════════════════════
  async showModuleLessons(moduleId) {
    this.currentView = 'lessons';
    const mod = this.modules.find(m => m.id === moduleId);
    if (!mod) return this.showDashboard();
    this.currentModule = mod;

    const lessonsHtml = mod.lessons.map((lesson, i) => {
      const badgeHtml = lesson.generated
        ? '<span class="lesson-badge cached">✓ em cache</span>'
        : '<span class="lesson-badge">🤖 gerar</span>';
      return `
        <div class="lesson-item ${lesson.completed ? 'completed' : ''}" onclick="App.startLesson('${mod.id}', '${lesson.id}')">
          <div class="lesson-status">
            ${lesson.completed ? '✅' : (i + 1)}
          </div>
          <div class="lesson-info">
            <div class="lesson-title">${lesson.titlePt || lesson.title} ${badgeHtml}</div>
            <div class="lesson-subtitle">${lesson.title} · ${lesson.type === 'quiz' ? 'perguntas' : lesson.type === 'speaking' ? 'falar' : 'vocabulário'}</div>
          </div>
          <span class="lesson-type ${lesson.type}">${lesson.type === 'quiz' ? '🧩 Quiz' : lesson.type === 'speaking' ? '🎙️ Falar' : '📖 Vocabulário'}</span>
        </div>
      `;
    }).join('');

    const courseTitle = this.currentCourse.titlePt || this.currentCourse.title;

    this.render(`
      <div class="lesson-list">
        <div class="breadcrumb">
          <a onclick="App.showCourseSelection()">Cursos</a> ›
          <a onclick="App.showDashboard()">${courseTitle}</a> ›
          <strong>${mod.titlePt || mod.title}</strong>
        </div>
        <button class="back-btn" onclick="App.showDashboard()">← Voltar</button>
        <div class="lesson-list-header">
          <span class="module-icon">${mod.icon || '📖'}</span>
          <div>
            <h2>${mod.titlePt || mod.title}</h2>
            <p style="color: var(--text-light)">${(mod.objectives || []).join(' · ')}</p>
          </div>
        </div>
        <div class="lessons-container">
          ${lessonsHtml}
        </div>
      </div>
    `);
  },

  // ═══════════════════════════════════════════════════════════
  // INICIAR LIÇÃO (com loading enquanto o LLM gera)
  // ═══════════════════════════════════════════════════════════
  async startLesson(moduleId, lessonId) {
    this.showLoading(
      '🤖 A preparar a lição...',
      'A inteligência artificial está a criar conteúdo personalizado para ti!'
    );

    try {
      const lesson = await this.api(
        `/api/courses/${this.currentCourse.id}/modules/${moduleId}/lessons/${lessonId}`
      );
      this.currentLesson = lesson;
      this.currentModule = this.modules.find(m => m.id === moduleId);

      if (lesson.type === 'vocabulary') {
        this.startVocabLesson(lesson);
      } else if (lesson.type === 'quiz') {
        this.startQuiz(lesson);
      } else if (lesson.type === 'speaking') {
        this.startSpeakingLesson(lesson);
      }
    } catch (err) {
      this.render(`
        <div class="loading-overlay">
          <div style="font-size: 3em">😕</div>
          <div class="loading-text">Erro ao carregar a lição</div>
          <div class="loading-subtext">${err.message}</div>
          <div style="margin-top: 20px; display: flex; gap: 12px;">
            <button class="btn btn-secondary" onclick="App.showModuleLessons('${moduleId}')">← Voltar</button>
            <button class="btn btn-primary" onclick="App.startLesson('${moduleId}', '${lessonId}')">🔄 Tentar de Novo</button>
          </div>
        </div>
      `);
    }
  },

  // ═══════════════════════════════════════════════════════════
  // LIÇÃO DE VOCABULÁRIO (interativa: aprender + desafios)
  // ═══════════════════════════════════════════════════════════
  vocabSequence: [],   // mixed array of {type:'word', ...} and {type:'challenge', ...}
  vocabScore: 0,
  vocabMaxScore: 0,
  vocabRevealed: false,

  startVocabLesson(lesson) {
    this.vocabIndex = 0;
    this.vocabScore = 0;
    this.vocabRevealed = false;
    this.currentView = 'vocab';
    this.vocabSequence = this.buildVocabSequence(lesson);
    this.vocabMaxScore = this.vocabSequence.filter(s => s.type === 'challenge').length;
    this.renderVocabItem();
  },

  // Build alternating sequence: 2-3 words then a challenge
  buildVocabSequence(lesson) {
    const words = lesson.words;
    const seq = [];
    const challengeTypes = ['translate', 'pick', 'listen', 'type'];
    let challengeIdx = 0;
    const learnedSoFar = [];

    for (let i = 0; i < words.length; i++) {
      seq.push({ type: 'word', data: words[i], wordIndex: i });
      learnedSoFar.push(words[i]);

      // Insert a challenge after every 2 words (or at end)
      if ((learnedSoFar.length >= 2 && learnedSoFar.length % 2 === 0) || i === words.length - 1) {
        const challenge = this.generateChallenge(
          learnedSoFar, words, challengeTypes[challengeIdx % challengeTypes.length]
        );
        if (challenge) {
          seq.push({ type: 'challenge', data: challenge });
          challengeIdx++;
        }
      }
    }
    return seq;
  },

  // Generate a challenge using already-learned words
  generateChallenge(learned, allWords, type) {
    // Pick a random word from what we learned
    const target = learned[Math.floor(Math.random() * learned.length)];

    // Get 3 distractors from all words (not the target)
    const others = allWords.filter(w => w.en !== target.en);
    const shuffled = others.sort(() => Math.random() - 0.5).slice(0, 3);

    if (type === 'translate') {
      // "What does 'X' mean in Portuguese?"
      const options = [target.pt, ...shuffled.map(w => w.pt)].sort(() => Math.random() - 0.5);
      return {
        challengeType: 'translate',
        question: `O que significa "${target.en}" em português?`,
        emoji: target.emoji || '🤔',
        answer: target.pt,
        options,
        speakWord: target.en,
      };
    }
    if (type === 'pick') {
      // "Which English word means 'X'?"
      const options = [target.en, ...shuffled.map(w => w.en)].sort(() => Math.random() - 0.5);
      return {
        challengeType: 'pick',
        question: `Qual é a palavra inglesa para "${target.pt}"?`,
        emoji: target.emoji || '🤔',
        answer: target.en,
        options,
        speakWord: target.en,
      };
    }
    if (type === 'listen') {
      // "Listen and pick the right word"
      const options = [target.en, ...shuffled.map(w => w.en)].sort(() => Math.random() - 0.5);
      return {
        challengeType: 'listen',
        question: 'Ouve a palavra e escolhe a correta:',
        emoji: '🎧',
        answer: target.en,
        options,
        speakWord: target.en,
        autoSpeak: true,
      };
    }
    if (type === 'type') {
      // "Type the English word for 'X'"
      return {
        challengeType: 'type',
        question: `Escreve a palavra inglesa para "${target.pt}":`,
        emoji: target.emoji || '✏️',
        answer: target.en,
        hint: target.en[0] + '...', // first letter hint
        speakWord: target.en,
      };
    }
    return null;
  },

  renderVocabItem() {
    if (this.vocabIndex >= this.vocabSequence.length) {
      this.finishVocabLesson();
      return;
    }
    const item = this.vocabSequence[this.vocabIndex];
    if (item.type === 'word') {
      this.vocabRevealed = false;
      this.renderVocabCard(this.currentLesson, item);
    } else {
      this.renderVocabChallenge(item.data);
    }
  },

  renderVocabCard(lesson, item) {
    const word = item.data;
    const total = this.vocabSequence.length;
    const wordItems = this.vocabSequence.filter(s => s.type === 'word');
    const wordNum = wordItems.indexOf(item) + 1;
    const wordTotal = wordItems.length;

    const dotsHtml = this.vocabSequence.map((s, i) => {
      const isChallenge = s.type === 'challenge';
      const cls = i === this.vocabIndex ? 'active' : (i < this.vocabIndex ? 'done' : '');
      return `<div class="vocab-dot ${cls} ${isChallenge ? 'challenge-dot' : ''}"></div>`;
    }).join('');

    const safeExample = (word.example || word.en).replace(/'/g, "\\'");
    const safeEn = word.en.replace(/'/g, "\\'");

    this.render(`
      <div class="vocab-lesson">
        <div class="vocab-header">
          <button class="back-btn" onclick="App.showModuleLessons('${this.currentModule.id}')">← Voltar</button>
          <div class="vocab-progress">${dotsHtml}</div>
          <span style="font-size: 0.9em; color: var(--text-light)">${wordNum}/${wordTotal}</span>
        </div>

        <div class="vocab-card-container">
          <div class="vocab-card" onclick="App.revealVocab()">
            <button class="speak-btn" onclick="event.stopPropagation(); App.speak('${safeExample}')" title="Ouvir">🔊</button>
            <div class="word-emoji">${word.emoji || '📝'}</div>
            <div class="word-en">${word.en}</div>
            <div class="word-phonetic">${word.phonetic || ''}</div>
            <div id="vocab-hidden-area">
              ${!this.vocabRevealed ? `
                <div class="reveal-prompt" onclick="App.revealVocab()">
                  <span class="reveal-icon">👆</span>
                  <span>Toca para ver a tradução!</span>
                </div>
              ` : `
                <div class="word-pt revealed">${word.pt}</div>
                ${word.example ? `
                  <div class="word-example revealed">
                    <strong>"${word.example}"</strong><br>
                    <span>${word.examplePt}</span>
                  </div>
                ` : ''}
              `}
            </div>
          </div>
        </div>

        <div class="vocab-nav">
          ${this.vocabIndex > 0 ? '<button class="btn btn-secondary" onclick="App.prevVocab()">← Anterior</button>' : '<div></div>'}
          <button class="btn btn-primary" onclick="App.nextVocab()" ${!this.vocabRevealed ? 'disabled' : ''}>
            ${this.vocabIndex >= total - 1 ? 'Terminar ✅' : 'Próximo →'}
          </button>
        </div>
      </div>
    `);

    // Auto-play pronunciation
    setTimeout(() => this.speak(word.en), 300);

    // Save vocabulary progress
    this.api('/api/vocabulary', {
      method: 'POST',
      body: {
        userId: this.userId,
        word: word.en,
        translation: word.pt,
        moduleId: this.currentModule.id,
        correct: true
      }
    }).catch(() => {});
  },

  revealVocab() {
    if (this.vocabRevealed) return;
    this.vocabRevealed = true;
    const item = this.vocabSequence[this.vocabIndex];
    if (item.type !== 'word') return;
    const word = item.data;
    const area = document.getElementById('vocab-hidden-area');
    if (area) {
      area.innerHTML = `
        <div class="word-pt revealed">${word.pt}</div>
        ${word.example ? `
          <div class="word-example revealed">
            <strong>"${word.example}"</strong><br>
            <span>${word.examplePt}</span>
          </div>
        ` : ''}
      `;
    }
    // Enable "next" button
    const nextBtn = document.querySelector('.vocab-nav .btn-primary');
    if (nextBtn) nextBtn.disabled = false;

    // Speak the PT translation too with a small delay
    setTimeout(() => this.speak(word.pt, this.currentCourse?.nativeLanguageLang || 'pt-PT'), 500);
  },

  renderVocabChallenge(challenge) {
    const total = this.vocabSequence.length;
    const dotsHtml = this.vocabSequence.map((s, i) => {
      const isChallenge = s.type === 'challenge';
      const cls = i === this.vocabIndex ? 'active' : (i < this.vocabIndex ? 'done' : '');
      return `<div class="vocab-dot ${cls} ${isChallenge ? 'challenge-dot' : ''}"></div>`;
    }).join('');

    const isTypeChallenge = challenge.challengeType === 'type';
    const safeAnswer = (challenge.answer || '').replace(/'/g, "\\'");

    this.render(`
      <div class="vocab-lesson">
        <div class="vocab-header">
          <button class="back-btn" onclick="App.showModuleLessons('${this.currentModule.id}')">← Voltar</button>
          <div class="vocab-progress">${dotsHtml}</div>
          <span style="font-size: 0.9em; color: var(--text-light)">⚡ Desafio</span>
        </div>

        <div class="challenge-card">
          <div class="challenge-badge">⚡ Desafio!</div>
          <div class="challenge-emoji">${challenge.emoji}</div>
          <div class="challenge-question">${challenge.question}</div>
          ${challenge.autoSpeak ? `<button class="btn btn-secondary challenge-listen-btn" onclick="App.speak('${safeAnswer}')">🔊 Ouvir outra vez</button>` : ''}

          ${isTypeChallenge ? `
            <div class="challenge-type-area">
              <div class="challenge-hint">Dica: ${challenge.hint}</div>
              <input type="text" id="challenge-type-input" class="challenge-input"
                     placeholder="Escreve aqui..." autocomplete="off" autocapitalize="off"
                     onkeydown="if(event.key==='Enter') App.submitTypeChallenge('${safeAnswer}')">
              <button class="btn btn-primary" onclick="App.submitTypeChallenge('${safeAnswer}')">Verificar ✓</button>
            </div>
          ` : `
            <div class="challenge-options">
              ${challenge.options.map(opt => {
                const safeOpt = opt.replace(/'/g, "\\'");
                return `<button class="challenge-option" onclick="App.answerChallenge(this, '${safeOpt}', '${safeAnswer}')">${opt}</button>`;
              }).join('')}
            </div>
          `}

          <div id="challenge-feedback"></div>
        </div>
      </div>
    `);

    // Auto-speak for listen challenges
    if (challenge.autoSpeak) {
      setTimeout(() => this.speak(challenge.speakWord), 400);
    }
  },

  answerChallenge(button, selected, correct) {
    if (this._challengeAnswered) return;
    this._challengeAnswered = true;

    const isCorrect = selected.toLowerCase().trim() === correct.toLowerCase().trim();
    const buttons = document.querySelectorAll('.challenge-option');

    buttons.forEach(btn => {
      btn.disabled = true;
      if (btn.textContent.trim().toLowerCase() === correct.toLowerCase().trim()) {
        btn.classList.add('correct');
      }
    });

    if (isCorrect) {
      button.classList.add('correct');
      this.vocabScore++;
      document.getElementById('challenge-feedback').innerHTML = `
        <div class="challenge-feedback correct">✅ Correto! Boa!</div>
      `;
      this.speak(correct);
    } else {
      button.classList.add('wrong');
      document.getElementById('challenge-feedback').innerHTML = `
        <div class="challenge-feedback wrong">❌ A resposta certa é: <strong>${correct}</strong></div>
      `;
      this.speak(correct);
    }

    setTimeout(() => {
      this._challengeAnswered = false;
      this.vocabIndex++;
      this.renderVocabItem();
    }, isCorrect ? 1500 : 2500);
  },

  submitTypeChallenge(correct) {
    const input = document.getElementById('challenge-type-input');
    if (!input) return;
    const typed = input.value.trim();
    if (!typed) return;
    if (this._challengeAnswered) return;
    this._challengeAnswered = true;

    input.disabled = true;
    const isCorrect = typed.toLowerCase() === correct.toLowerCase();

    if (isCorrect) {
      this.vocabScore++;
      input.classList.add('correct');
      document.getElementById('challenge-feedback').innerHTML = `
        <div class="challenge-feedback correct">✅ Perfeito! Muito bem!</div>
      `;
      this.speak(correct);
    } else {
      input.classList.add('wrong');
      document.getElementById('challenge-feedback').innerHTML = `
        <div class="challenge-feedback wrong">❌ A resposta certa é: <strong>${correct}</strong></div>
      `;
      this.speak(correct);
    }

    setTimeout(() => {
      this._challengeAnswered = false;
      this.vocabIndex++;
      this.renderVocabItem();
    }, isCorrect ? 1500 : 2500);
  },

  nextVocab() {
    this.vocabIndex++;
    if (this.vocabIndex >= this.vocabSequence.length) {
      this.finishVocabLesson();
    } else {
      this.renderVocabItem();
    }
  },

  prevVocab() {
    if (this.vocabIndex > 0) {
      this.vocabIndex--;
      this.vocabRevealed = true; // already seen
      this.renderVocabItem();
    }
  },

  async finishVocabLesson() {
    const words = this.currentLesson.words.length;
    const challenges = this.vocabMaxScore;
    // Score: all words count as correct (they studied them) + challenge score
    const score = words + this.vocabScore;
    const maxScore = words + challenges;
    try {
      const result = await this.api('/api/progress', {
        method: 'POST',
        body: {
          userId: this.userId,
          moduleId: this.currentModule.id,
          lessonId: this.currentLesson.id,
          score,
          maxScore
        }
      });
      this.showResults(score, maxScore, result.starsEarned);
    } catch (err) {
      this.showResults(score, maxScore, 3);
    }
  },

  // ═══════════════════════════════════════════════════════════
  // EXERCÍCIO DE SPEAKING (reconhecimento de voz)
  // ═══════════════════════════════════════════════════════════
  speechRecognition: null,
  speakingState: null,
  micPermission: null, // 'granted' | 'denied' | 'prompt' | null

  checkSpeechSupport() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  },

  // Request microphone permission explicitly (needed for Android Chrome)
  async requestMicPermission() {
    // Already granted?
    if (this.micPermission === 'granted') return true;

    // Check via Permissions API first (if available)
    try {
      if (navigator.permissions) {
        const status = await navigator.permissions.query({ name: 'microphone' });
        this.micPermission = status.state;
        if (status.state === 'granted') return true;
      }
    } catch (e) { /* Permissions API not available on some browsers */ }

    // Must call getUserMedia to trigger the permission popup
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Stop the stream immediately (we just needed the permission)
      stream.getTracks().forEach(track => track.stop());
      this.micPermission = 'granted';
      return true;
    } catch (err) {
      console.log('Mic permission denied:', err.name, err.message);
      this.micPermission = 'denied';

      // Check if it's a secure context issue
      if (!window.isSecureContext) {
        this.showMicError(
          '🔒 Esta página precisa de HTTPS para usar o microfone.',
          `No telemóvel, acede a: <strong>https://${location.hostname}:${Number(location.port || 80) + 443}</strong>`
        );
      } else if (err.name === 'NotAllowedError') {
        this.showMicError(
          '🎙️ Permissão do microfone negada.',
          'Vai a Definições do Chrome → Definições do site → Microfone e permite este site.'
        );
      } else {
        this.showMicError(
          '⚠️ Não foi possível aceder ao microfone.',
          `Erro: ${err.message}. Podes usar o campo de texto para responder.`
        );
      }
      return false;
    }
  },

  showMicError(title, detail) {
    const resultDiv = document.getElementById('speaking-result');
    if (resultDiv) {
      resultDiv.innerHTML = `<div class="speaking-feedback info">
        <div><strong>${title}</strong></div>
        <div style="margin-top:6px; font-size:0.9em">${detail}</div>
      </div>`;
    }
  },

  startSpeakingLesson(lesson) {
    this.currentView = 'speaking';
    this.speakingState = {
      exercises: lesson.exercises,
      currentIndex: 0,
      score: 0,
      answered: false,
      listening: false,
      lastResult: null,
      networkRetries: 0,
    };

    // Request mic permission up front (shows the popup on Android)
    if (this.checkSpeechSupport() && this.micPermission !== 'granted') {
      this.requestMicPermission().then(() => {
        this.renderSpeakingExercise();
      });
    } else {
      this.renderSpeakingExercise();
    }
  },

  renderSpeakingExercise() {
    const { exercises, currentIndex, score, answered } = this.speakingState;
    const ex = exercises[currentIndex];
    const total = exercises.length;
    const progress = (currentIndex / total) * 100;
    const hasSupport = this.checkSpeechSupport();
    const isSecure = window.isSecureContext;
    const micAllowed = this.micPermission !== 'denied';
    const canUseMic = hasSupport && isSecure && micAllowed;

    const difficultyLabel = { easy: '🟢 Fácil', medium: '🟡 Médio', hard: '🟠 Difícil' };
    const safePhrase = ex.phrase.replace(/'/g, "\\'");

    this.render(`
      <div class="speaking-view">
        <button class="back-btn" onclick="App.showModuleLessons('${this.currentModule.id}')">← Voltar</button>

        <div class="quiz-progress-bar">
          <div class="quiz-progress-fill" style="width: ${progress}%"></div>
        </div>

        <div class="speaking-header">
          <span>Exercício ${currentIndex + 1} de ${total}</span>
          <span>${difficultyLabel[ex.difficulty] || '🟢 Fácil'}</span>
        </div>

        <div class="speaking-card">
          <div class="speaking-emoji">${ex.emoji || '🗣️'}</div>

          <div class="speaking-instruction">Diz em voz alta:</div>

          <div class="speaking-phrase" onclick="App.speak('${safePhrase}')">
            ${ex.phrase}
            <button class="speak-btn" onclick="event.stopPropagation(); App.speak('${safePhrase}')" title="Ouvir">🔊</button>
          </div>

          <div class="speaking-phonetic">${ex.phonetic || ''}</div>
          <div class="speaking-translation">${ex.phrasePt}</div>

          ${ex.hintPt ? `<div class="speaking-hint">💡 <strong>Dica:</strong> ${ex.hintPt}</div>` : ''}

          ${!canUseMic ? `
            <div class="speaking-no-support">
              ${!hasSupport
                ? '⚠️ O teu browser não suporta reconhecimento de voz. Usa o Chrome ou Edge.'
                : !isSecure
                  ? `🔒 O microfone precisa de HTTPS. No telemóvel acede a:<br><strong>https://${location.hostname}:${Number(location.port || 80) + 443}</strong>`
                  : '🎙️ O microfone não está disponível. Podes escrever a resposta em baixo.'
              }
            </div>
            <div class="speaking-type-fallback" style="margin-top:12px">
              <div class="speaking-type-row">
                <input type="text" id="speaking-type-input" class="speaking-type-input"
                  placeholder="Escreve em inglês..."
                  onkeydown="if(event.key==='Enter') App.submitTypedAnswer()" />
                <button class="btn btn-primary" onclick="App.submitTypedAnswer()">✓</button>
              </div>
            </div>
            <div id="speaking-result"></div>
            <div class="speaking-buttons">
              <button class="btn btn-secondary" onclick="App.speak('${safePhrase}')">🔊 Ouvir</button>
              <button class="btn btn-primary" onclick="App.skipSpeakingExercise()">Seguinte →</button>
            </div>
          ` : `
            <div id="speaking-prompt" class="speaking-prompt">
              <div class="speaking-prompt-text">🎤 Agora é a tua vez!</div>
              <div class="speaking-prompt-sub">Ouve, repete em voz alta, e depois escolhe como responder:</div>
            </div>

            <div class="speaking-response-options">
              <div class="speaking-option-mic">
                <div id="speaking-mic-area">
                  <button id="mic-btn" class="mic-btn ${this.speakingState.listening ? 'listening' : ''}" onclick="App.toggleListening()">
                    ${this.speakingState.listening ? '🔴' : '🎙️'}
                  </button>
                  <div class="mic-label">${this.speakingState.listening ? 'A ouvir... fala agora!' : 'Clica e fala'}</div>
                </div>
              </div>

              <div class="speaking-option-divider">ou</div>

              <div class="speaking-option-type">
                <div class="speaking-type-fallback">
                  <div class="speaking-type-row">
                    <input type="text" id="speaking-type-input" class="speaking-type-input"
                      placeholder="Escreve em inglês..."
                      onkeydown="if(event.key==='Enter') App.submitTypedAnswer()" />
                    <button class="btn btn-primary" onclick="App.submitTypedAnswer()">✓</button>
                  </div>
                </div>
              </div>
            </div>

            <div id="speaking-result"></div>

            <div id="speaking-buttons" style="display: ${answered ? 'flex' : 'none'}" class="speaking-buttons">
              <button class="btn btn-secondary" onclick="App.speak('${safePhrase}')">🔊 Ouvir outra vez</button>
              <button class="btn btn-primary" onclick="App.retrySpeaking()">🎙️ Tentar de novo</button>
              <button class="btn btn-success" onclick="App.nextSpeakingExercise()">
                ${currentIndex < total - 1 ? 'Próximo →' : 'Terminar ✅'}
              </button>
            </div>
          `}
        </div>

        <div class="speaking-score">Pontuação: ${Math.round(score)}/${currentIndex}${answered ? '' : ''}</div>
      </div>
    `);

    // Auto-play the phrase (do NOT auto-start mic — let user click when ready)
    if (!answered) {
      setTimeout(() => this.speak(ex.phrase), 400);
    }
  },

  toggleListening() {
    if (this.speakingState.listening) {
      this.stopListening();
    } else {
      this.startListening();
    }
  },

  async startListening() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    // Request mic permission if not yet granted (triggers popup on Android)
    if (this.micPermission !== 'granted') {
      const ok = await this.requestMicPermission();
      if (!ok) return;
    }

    // IMPORTANT: Stop TTS before starting recognition (avoids "network" error)
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }

    // Stop any existing recognition
    if (this.speechRecognition) {
      try { this.speechRecognition.abort(); } catch(e) {}
    }

    const recognition = new SpeechRecognition();
    const speechLang = this.currentCourse?.speechLang || 'en-GB';
    recognition.lang = speechLang;
    recognition.interimResults = true;
    recognition.maxAlternatives = 3;
    recognition.continuous = false;

    this.speechRecognition = recognition;
    this.speakingState.listening = true;
    this.speakingState.answered = false;
    this.speakingState.lastTranscript = '';
    this.speakingState.evaluated = false;

    // Update UI
    const micBtn = document.getElementById('mic-btn');
    const micLabel = document.querySelector('.mic-label');
    const resultDiv = document.getElementById('speaking-result');
    if (micBtn) { micBtn.className = 'mic-btn listening'; micBtn.textContent = '🔴'; }
    if (micLabel) micLabel.textContent = 'A ouvir... fala agora!';
    if (resultDiv) resultDiv.innerHTML = '<div class="speaking-listening-indicator"><span class="pulse-dot"></span> A ouvir...</div>';

    recognition.onresult = (event) => {
      let transcript = '';
      let bestConfidence = 0;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript = event.results[i][0].transcript;
        bestConfidence = Math.max(bestConfidence, event.results[i][0].confidence || 0);
      }

      // Always save the latest transcript
      this.speakingState.lastTranscript = transcript;
      this.speakingState.lastConfidence = bestConfidence;

      if (resultDiv) {
        resultDiv.innerHTML = `<div class="speaking-transcript">"${transcript}"</div>`;
      }

      // If final result, evaluate immediately
      if (event.results[event.results.length - 1].isFinal) {
        this.speakingState.evaluated = true;
        this.evaluateSpeaking(transcript, event.results[event.results.length - 1]);
      }
    };

    this.speakingState.networkRetries = this.speakingState.networkRetries || 0;

    recognition.onerror = (event) => {
      console.log('Speech error:', event.error);
      this.speakingState.listening = false;
      if (micBtn) { micBtn.className = 'mic-btn'; micBtn.textContent = '🎙️'; }
      if (micLabel) micLabel.textContent = 'Clica no microfone e fala';

      if (event.error === 'no-speech') {
        if (resultDiv) resultDiv.innerHTML = '<div class="speaking-feedback info">🤔 Não ouvi nada. Tenta falar mais alto e mais perto do microfone!</div>';
        this.showSpeakingFallback();
      } else if (event.error === 'not-allowed') {
        if (resultDiv) resultDiv.innerHTML = '<div class="speaking-feedback info">⚠️ Precisas de dar permissão ao microfone. Clica no ícone 🔒 na barra do browser e permite o microfone.</div>';
        this.showSpeakingFallback();
      } else if (event.error === 'network') {
        // Auto-retry once, then show fallback
        if (this.speakingState.networkRetries < 1) {
          this.speakingState.networkRetries++;
          if (resultDiv) resultDiv.innerHTML = '<div class="speaking-feedback info">🔄 Erro de rede. A tentar de novo...</div>';
          setTimeout(() => this.startListening(), 1000);
          return;
        }
        if (resultDiv) resultDiv.innerHTML = '<div class="speaking-feedback info">⚠️ O reconhecimento de voz precisa de ligação à internet e HTTPS.<br>Podes escrever a resposta em baixo!</div>';
        this.showSpeakingFallback();
      } else if (event.error === 'aborted') {
        // Ignore aborted errors (we abort manually sometimes)
      } else {
        if (resultDiv) resultDiv.innerHTML = `<div class="speaking-feedback info">⚠️ Erro: ${event.error}. Tenta outra vez!</div>`;
        this.showSpeakingFallback();
      }
    };

    recognition.onend = () => {
      this.speakingState.listening = false;
      if (micBtn) { micBtn.className = 'mic-btn'; micBtn.textContent = '🎙️'; }
      if (micLabel) micLabel.textContent = 'Clica no microfone e fala';

      // If we got a transcript but never evaluated (no isFinal), evaluate now
      if (this.speakingState.lastTranscript && !this.speakingState.evaluated) {
        this.speakingState.evaluated = true;
        this.evaluateSpeaking(this.speakingState.lastTranscript, null);
      }
    };

    recognition.start();
  },

  stopListening() {
    if (this.speechRecognition) {
      try { this.speechRecognition.stop(); } catch(e) {}
    }
    this.speakingState.listening = false;
  },

  showSpeakingFallback() {
    // Show buttons so user can retry/skip
    const buttonsDiv = document.getElementById('speaking-buttons');
    if (buttonsDiv) buttonsDiv.style.display = 'flex';
    this.speakingState.answered = true;
    // Focus the text input
    setTimeout(() => {
      const input = document.getElementById('speaking-type-input');
      if (input) input.focus();
    }, 100);
  },

  submitTypedAnswer() {
    const input = document.getElementById('speaking-type-input');
    if (!input) return;
    const typed = input.value.trim();
    if (!typed) {
      input.classList.add('shake');
      setTimeout(() => input.classList.remove('shake'), 500);
      return;
    }
    this.evaluateSpeaking(typed, null);
  },

  evaluateSpeaking(transcript, result) {
    const ex = this.speakingState.exercises[this.speakingState.currentIndex];
    const clean = s => (s || '').toLowerCase().replace(/[^a-z0-9\s]/gi, '').trim();
    const expected = clean(ex.phrase);
    const spoken = clean(transcript);

    // Check main phrase and alternatives
    const acceptedForms = [expected, ...(ex.acceptAlso || []).map(a => clean(a))];

    // Calculate similarity
    const similarity = this.calculateSimilarity(spoken, expected);
    const isExactMatch = acceptedForms.some(form => spoken === form);
    const isCloseMatch = similarity >= 0.65;
    const isPartialMatch = similarity >= 0.3;

    // Confidence from speech API (may be null if from interim)
    const confidence = result && result[0] ? result[0].confidence : this.speakingState.lastConfidence || 0;

    // Build word-by-word comparison
    const expectedWords = expected.split(/\s+/);
    const spokenWords = spoken.split(/\s+/);
    const wordComparison = expectedWords.map(ew => {
      const matched = spokenWords.some(sw => {
        if (sw === ew) return true;
        const maxDist = ew.length <= 4 ? 1 : 2;
        return this.levenshtein(sw, ew) <= maxDist;
      });
      return `<span class="word-${matched ? 'ok' : 'miss'}">${ew}</span>`;
    }).join(' ');

    this.speakingState.answered = true;
    let feedbackHtml = '';

    const youSaid = transcript
      ? `Ouvimos: <strong>"${transcript}"</strong>`
      : 'Não conseguimos perceber o que disseste';

    if (isExactMatch || (isCloseMatch && confidence > 0.4)) {
      this.speakingState.score++;
      feedbackHtml = `
        <div class="speaking-feedback correct">
          <div class="speaking-feedback-icon">✅</div>
          <div>Muito bem! ${youSaid}</div>
          <div class="speaking-confidence">🎯 ${Math.round(Math.max(similarity, confidence) * 100)}% de precisão</div>
        </div>
      `;
    } else if (isCloseMatch || isPartialMatch) {
      this.speakingState.score += isCloseMatch ? 0.75 : 0.25;
      feedbackHtml = `
        <div class="speaking-feedback partial">
          <div class="speaking-feedback-icon">🟡</div>
          <div>${youSaid}</div>
          <div style="margin-top:8px">O correto é: <strong>"${ex.phrase}"</strong></div>
          <div class="speaking-word-comparison">${wordComparison}</div>
          <div class="speaking-confidence">🎯 ${Math.round(similarity * 100)}% de precisão — Tenta outra vez!</div>
        </div>
      `;
    } else {
      feedbackHtml = `
        <div class="speaking-feedback wrong">
          <div class="speaking-feedback-icon">❌</div>
          <div>${youSaid}</div>
          <div style="margin-top:8px">O correto é: <strong>"${ex.phrase}"</strong></div>
          <div class="speaking-word-comparison">${wordComparison}</div>
          <div class="speaking-hint-feedback">
            💡 Ouve com atenção e tenta repetir. Clica no 🔊 para ouvir de novo.
          </div>
        </div>
      `;
    }

    const resultDiv = document.getElementById('speaking-result');
    if (resultDiv) resultDiv.innerHTML = feedbackHtml;

    const buttonsDiv = document.getElementById('speaking-buttons');
    if (buttonsDiv) buttonsDiv.style.display = 'flex';

    // Pronounce correctly after feedback
    setTimeout(() => this.speak(ex.phrase), 800);
  },

  calculateSimilarity(a, b) {
    if (a === b) return 1;
    if (!a || !b) return 0;

    const wordsA = a.split(/\s+/);
    const wordsB = b.split(/\s+/);

    // Word-level matching
    let matchCount = 0;
    for (const wordA of wordsA) {
      if (wordsB.some(wordB => {
        if (wordA === wordB) return true;
        // Allow Levenshtein distance of 1 for short words, 2 for longer
        const maxDist = wordB.length <= 4 ? 1 : 2;
        return this.levenshtein(wordA, wordB) <= maxDist;
      })) {
        matchCount++;
      }
    }

    return matchCount / Math.max(wordsA.length, wordsB.length);
  },

  levenshtein(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b[i - 1] === a[j - 1]) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    return matrix[b.length][a.length];
  },

  retrySpeaking() {
    this.speakingState.answered = false;
    this.speakingState.networkRetries = 0;
    this.renderSpeakingExercise();
  },

  nextSpeakingExercise() {
    this.speakingState.currentIndex++;
    this.speakingState.answered = false;

    if (this.speakingState.currentIndex >= this.speakingState.exercises.length) {
      this.finishSpeaking();
    } else {
      this.renderSpeakingExercise();
    }
  },

  skipSpeakingExercise() {
    this.nextSpeakingExercise();
  },

  async finishSpeaking() {
    const { score, exercises } = this.speakingState;
    const maxScore = exercises.length;
    const roundedScore = Math.round(score);

    try {
      const result = await this.api('/api/progress', {
        method: 'POST',
        body: {
          userId: this.userId,
          moduleId: this.currentModule.id,
          lessonId: this.currentLesson.id,
          score: roundedScore,
          maxScore
        }
      });
      this.showResults(roundedScore, maxScore, result.starsEarned);
    } catch (err) {
      this.showResults(roundedScore, maxScore, 0);
    }
  },

  // ═══════════════════════════════════════════════════════════
  // QUIZ (com explicações)
  // ═══════════════════════════════════════════════════════════
  startQuiz(lesson) {
    this.currentView = 'quiz';
    this.quizState = {
      questions: [...lesson.questions].sort(() => Math.random() - 0.5),
      currentIndex: 0,
      score: 0,
      answered: false
    };
    this.renderQuizQuestion();
  },

  renderQuizQuestion() {
    const { questions, currentIndex, score } = this.quizState;
    const q = questions[currentIndex];
    const total = questions.length;
    const progress = ((currentIndex) / total) * 100;

    // Baralhar opções
    const options = [...q.options].sort(() => Math.random() - 0.5);

    this.render(`
      <div class="quiz-view">
        <button class="back-btn" onclick="App.showModuleLessons('${this.currentModule.id}')">← Voltar</button>

        <div class="quiz-progress-bar">
          <div class="quiz-progress-fill" style="width: ${progress}%"></div>
        </div>

        <div class="quiz-question-number">Pergunta ${currentIndex + 1} de ${total}</div>

        <div class="quiz-card">
          ${q.emoji ? `<div class="quiz-emoji">${q.emoji}</div>` : ''}
          <div class="quiz-question">${q.question}</div>
          <div class="quiz-question-pt">${q.questionPt}</div>

          <div class="quiz-options">
            ${options.map(opt => `
              <button class="quiz-option" onclick="App.answerQuiz(this, '${opt.replace(/'/g, "\\'")}', '${q.answer.replace(/'/g, "\\'")}')">${opt}</button>
            `).join('')}
          </div>

          <div id="quiz-feedback"></div>
        </div>
      </div>
    `);
  },

  answerQuiz(button, selected, correct) {
    if (this.quizState.answered) return;
    this.quizState.answered = true;

    const isCorrect = selected === correct;
    const buttons = document.querySelectorAll('.quiz-option');
    const q = this.quizState.questions[this.quizState.currentIndex];

    // Desativar todos os botões e mostrar a correta
    buttons.forEach(btn => {
      btn.disabled = true;
      if (btn.textContent.trim() === correct) {
        btn.classList.add('correct');
      }
    });

    // Preparar a explicação
    const explanationText = q.explanationPt || q.explanation || '';

    if (isCorrect) {
      button.classList.add('correct');
      this.quizState.score++;
      document.getElementById('quiz-feedback').innerHTML = `
        <div class="quiz-feedback correct">✅ Correto! Muito bem!</div>
        ${explanationText ? `<div class="quiz-explanation correct-explanation">💡 <strong>Sabias?</strong> ${explanationText}</div>` : ''}
      `;
      this.speak(correct);
    } else {
      button.classList.add('wrong');
      document.getElementById('quiz-feedback').innerHTML = `
        <div class="quiz-feedback wrong">❌ A resposta certa é: <strong>${correct}</strong></div>
        ${explanationText ? `<div class="quiz-explanation">💡 <strong>Porquê?</strong> ${explanationText}</div>` : ''}
      `;
      this.speak(correct);
    }

    // Guardar vocabulário
    this.api('/api/vocabulary', {
      method: 'POST',
      body: {
        userId: this.userId,
        word: q.answer,
        translation: '',
        moduleId: this.currentModule.id,
        correct: isCorrect
      }
    }).catch(() => {});

    // Avançar automaticamente depois de um tempo
    const delay = isCorrect ? 2500 : 4000; // mais tempo se errou, para ler a explicação
    setTimeout(() => {
      this.quizState.currentIndex++;
      this.quizState.answered = false;

      if (this.quizState.currentIndex >= this.quizState.questions.length) {
        this.finishQuiz();
      } else {
        this.renderQuizQuestion();
      }
    }, delay);
  },

  async finishQuiz() {
    const { score, questions } = this.quizState;
    const maxScore = questions.length;

    try {
      const result = await this.api('/api/progress', {
        method: 'POST',
        body: {
          userId: this.userId,
          moduleId: this.currentModule.id,
          lessonId: this.currentLesson.id,
          score,
          maxScore
        }
      });
      this.showResults(score, maxScore, result.starsEarned);
    } catch (err) {
      this.showResults(score, maxScore, 0);
    }
  },

  // ═══════════════════════════════════════════════════════════
  // RESULTADOS
  // ═══════════════════════════════════════════════════════════
  showResults(score, maxScore, starsEarned) {
    this.currentView = 'results';
    const percentage = Math.round((score / maxScore) * 100);
    const passed = percentage >= 70;

    let emoji, title, subtitle;
    if (percentage === 100) {
      emoji = '🏆';
      title = 'Perfeito!';
      subtitle = 'Não erraste nada! Incrível!';
    } else if (percentage >= 80) {
      emoji = '🌟';
      title = 'Muito Bem!';
      subtitle = 'Estás quase perfeito!';
    } else if (passed) {
      emoji = '👏';
      title = 'Bom Trabalho!';
      subtitle = 'Passaste! Continua assim!';
    } else {
      emoji = '💪';
      title = 'Continua a Tentar!';
      subtitle = 'Precisas de 70% para passar. Tenta outra vez!';
    }

    const starsHtml = '⭐'.repeat(starsEarned) + '☆'.repeat(3 - starsEarned);

    this.render(`
      <div class="results-view">
        <div class="results-card">
          <div class="results-emoji">${emoji}</div>
          <div class="results-title">${title}</div>
          <div class="results-subtitle">${subtitle}</div>
          <div class="results-stars">${starsHtml}</div>
          <div class="results-score">
            Resultado: <strong>${score}/${maxScore}</strong> (${percentage}%)
          </div>
          <div class="results-buttons">
            <button class="btn btn-secondary" onclick="App.showModuleLessons('${this.currentModule.id}')">← Voltar às Lições</button>
            <button class="btn btn-primary" onclick="App.startLesson('${this.currentModule.id}', '${this.currentLesson.id}')">🔄 Repetir</button>
            <button class="btn btn-success" onclick="App.showDashboard()">🏠 Módulos</button>
          </div>
          <div style="margin-top: 16px;">
            <button class="regenerate-btn" onclick="App.regenerateLesson('${this.currentModule.id}', '${this.currentLesson.id}')">🔄 Gerar novo conteúdo (IA)</button>
          </div>
        </div>
      </div>
    `);

    if (passed) this.showConfetti();
  },

  async regenerateLesson(moduleId, lessonId) {
    this.showLoading(
      '🤖 A gerar novo conteúdo...',
      'A inteligência artificial está a criar perguntas e conteúdo diferente!'
    );
    try {
      await this.api(
        `/api/courses/${this.currentCourse.id}/modules/${moduleId}/lessons/${lessonId}/regenerate`,
        { method: 'POST' }
      );
      // Recarregar a lição
      this.startLesson(moduleId, lessonId);
    } catch (err) {
      alert('Erro ao regenerar: ' + err.message);
      this.showModuleLessons(moduleId);
    }
  },

  // ═══════════════════════════════════════════════════════════
  // ESTATÍSTICAS
  // ═══════════════════════════════════════════════════════════
  async showStats() {
    this.currentView = 'stats';
    let stats = {};
    try {
      stats = await this.api(`/api/users/${this.userId}/stats`);
    } catch (e) {
      console.error(e);
    }

    const totalModules = this.modules.length;
    const completedModules = this.modules.filter(m => m.progress === 100).length;
    const courseTitle = this.currentCourse?.titlePt || this.currentCourse?.title || '';

    this.render(`
      <div class="stats-view">
        <div class="top-bar">
          <button class="back-btn" onclick="App.showDashboard()">← Voltar</button>
          <div class="user-info">
            <span class="user-avatar">${this.userAvatar}</span>
            <span>${this.userName}</span>
          </div>
        </div>

        <div class="breadcrumb">
          <a onclick="App.showCourseSelection()">Cursos</a> ›
          <a onclick="App.showDashboard()">${courseTitle}</a> ›
          <strong>Progresso</strong>
        </div>

        <div class="nav-tabs">
          <button class="nav-tab" onclick="App.showDashboard()">📚 Módulos</button>
          <button class="nav-tab active" onclick="App.showStats()">📊 Progresso</button>
          <button class="nav-tab" onclick="App.showVocabReview()">🔤 Vocabulário</button>
        </div>

        <h2 style="margin-bottom: 20px">📊 O Teu Progresso</h2>

        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon">🔥</div>
            <div class="stat-value">${stats.streak?.current_streak || 0}</div>
            <div class="stat-label">Dias Seguidos</div>
          </div>
          <div class="stat-card">
            <div class="stat-icon">⭐</div>
            <div class="stat-value">${stats.streak?.total_stars || 0}</div>
            <div class="stat-label">Estrelas</div>
          </div>
          <div class="stat-card">
            <div class="stat-icon">📖</div>
            <div class="stat-value">${stats.completedLessons}/${stats.totalLessons}</div>
            <div class="stat-label">Lições Completas</div>
          </div>
          <div class="stat-card">
            <div class="stat-icon">🏆</div>
            <div class="stat-value">${completedModules}/${totalModules}</div>
            <div class="stat-label">Módulos Completos</div>
          </div>
          <div class="stat-card">
            <div class="stat-icon">🎯</div>
            <div class="stat-value">${stats.totalAttempts || 0}</div>
            <div class="stat-label">Tentativas</div>
          </div>
          <div class="stat-card">
            <div class="stat-icon">📝</div>
            <div class="stat-value">${stats.vocabMastered}/${stats.vocabTotal}</div>
            <div class="stat-label">Palavras Dominadas</div>
          </div>
        </div>

        <div class="section-title">🏅 Recordes</div>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon">🔥</div>
            <div class="stat-value">${stats.streak?.longest_streak || 0}</div>
            <div class="stat-label">Maior Sequência</div>
          </div>
        </div>
      </div>
    `);
  },

  // ═══════════════════════════════════════════════════════════
  // REVISÃO DE VOCABULÁRIO
  // ═══════════════════════════════════════════════════════════
  async showVocabReview() {
    this.currentView = 'vocabReview';
    let words = [];
    try {
      words = await this.api(`/api/users/${this.userId}/vocabulary`);
    } catch (e) {
      console.error(e);
    }

    const wordsHtml = words.length > 0
      ? words.map(w => {
          const status = w.mastered ? 'mastered' : w.times_correct > 0 ? 'learning' : 'new';
          const statusLabel = w.mastered ? '✅' : w.times_correct > 0 ? '📖' : '🆕';
          const safeWord = w.word.replace(/'/g, "\\'");
          return `
            <div class="vocab-review-card" onclick="App.speak('${safeWord}')">
              <div class="word-status ${status}"></div>
              <div>
                <div class="word-text">${statusLabel} ${w.word}</div>
                <div class="word-translation">${w.translation}</div>
              </div>
            </div>
          `;
        }).join('')
      : `
        <div class="empty-state">
          <div class="empty-icon">📚</div>
          <h3>Ainda não tens vocabulário</h3>
          <p>Completa lições para adicionar palavras ao teu vocabulário!</p>
        </div>
      `;

    const mastered = words.filter(w => w.mastered).length;
    const learning = words.filter(w => !w.mastered && w.times_correct > 0).length;
    const newWords = words.filter(w => w.times_correct === 0).length;
    const courseTitle = this.currentCourse?.titlePt || this.currentCourse?.title || '';

    this.render(`
      <div class="stats-view">
        <div class="top-bar">
          <button class="back-btn" onclick="App.showDashboard()">← Voltar</button>
          <div class="user-info">
            <span class="user-avatar">${this.userAvatar}</span>
            <span>${this.userName}</span>
          </div>
        </div>

        <div class="breadcrumb">
          <a onclick="App.showCourseSelection()">Cursos</a> ›
          <a onclick="App.showDashboard()">${courseTitle}</a> ›
          <strong>Vocabulário</strong>
        </div>

        <div class="nav-tabs">
          <button class="nav-tab" onclick="App.showDashboard()">📚 Módulos</button>
          <button class="nav-tab" onclick="App.showStats()">📊 Progresso</button>
          <button class="nav-tab active" onclick="App.showVocabReview()">🔤 Vocabulário</button>
        </div>

        <h2 style="margin-bottom: 8px">📚 O Meu Vocabulário</h2>
        <p style="color: var(--text-light); margin-bottom: 20px">
          ✅ ${mastered} dominadas · 📖 ${learning} a aprender · 🆕 ${newWords} novas
        </p>
        <p style="color: var(--text-muted); font-size: 0.85em; margin-bottom: 16px">
          💡 Clica numa palavra para a ouvir!
        </p>

        <div class="vocab-review-grid">
          ${wordsHtml}
        </div>
      </div>
    `);
  },

  // ═══════════════════════════════════════════════════════════
  // CONFIGURAÇÃO LLM (por conta)
  // ═══════════════════════════════════════════════════════════
  async showLlmSettings() {
    this.currentView = 'llmSettings';

    if (!this.accountId) {
      alert('Precisas de iniciar sessão com Google para configurar o LLM.');
      this.showCourseSelection();
      return;
    }

    let providers = [];
    let currentCfg = {};
    try {
      [providers, currentCfg] = await Promise.all([
        this.api('/api/llm-providers'),
        this.api(`/api/accounts/${this.accountId}/llm-config`),
      ]);
    } catch (e) {
      console.error('Falha ao carregar configuração LLM:', e);
    }

    this._llmProviders = providers;
    this._llmCurrentCfg = currentCfg;

    const providerOptions = providers.map(p =>
      `<option value="${p.id}" ${currentCfg.provider === p.id ? 'selected' : ''}>${this.escapeHtml(p.label)}</option>`
    ).join('');

    const courseTitle = this.currentCourse?.titlePt || this.currentCourse?.title || '';
    const hasLocalKey = this.hasStoredApiKey();
    const keyUnlocked = Boolean(this._llmApiKey);
    const keyStatusHtml = hasLocalKey
      ? (keyUnlocked
        ? '<span style="color:#27ae60">🔓 Chave desbloqueada para esta sessão</span>'
        : '<span style="color:#e67e22">🔒 Chave guardada localmente (bloqueada) — <a href="#" onclick="App.unlockApiKeyFromSettings();return false">desbloquear</a></span>')
      : '';

    this.render(`
      <div class="settings-view">
        <div class="top-bar">
          <button class="back-btn" onclick="App.showDashboard ? App.showDashboard() : App.showCourseSelection()">← Voltar</button>
          <div class="user-info">
            <span class="user-avatar">${this.userAvatar || '👤'}</span>
            <span>${this.userName || this.accountName || ''}</span>
          </div>
        </div>

        ${courseTitle ? `
        <div class="breadcrumb">
          <a onclick="App.showCourseSelection()">Cursos</a> ›
          <a onclick="App.showDashboard()">${courseTitle}</a> ›
          <strong>Configuração LLM</strong>
        </div>` : `
        <div class="breadcrumb">
          <strong>Configuração LLM</strong>
        </div>`}

        <div class="settings-card">
          <h2>🤖 Provedor de IA</h2>
          <p class="settings-desc">
            Configura o provedor de IA usado para gerar lições.
            ${currentCfg.usingDefault ? '<span class="badge-default">A usar predefinição do servidor</span>' : '<span class="badge-custom">Configuração personalizada</span>'}
          </p>

          <div class="form-group">
            <label for="llmProvider">Provedor</label>
            <select id="llmProvider" class="settings-select" onchange="App.onProviderChange()">
              <option value="">— Usar predefinição do servidor —</option>
              ${providerOptions}
            </select>
          </div>

          <div id="llmConfigFields" style="display: ${currentCfg.provider ? 'block' : 'none'}">
            <div class="form-group" id="llmUrlGroup">
              <label for="llmUrl">URL do API</label>
              <input type="text" id="llmUrl" placeholder="https://api.example.com/v1" value="${this.escapeHtml(currentCfg.llmUrl || '')}">
              <small class="field-hint" id="llmUrlHint"></small>
            </div>

            <div class="form-group" id="llmApiKeyGroup">
              <label for="llmApiKey">Chave API</label>
              <div class="input-with-icon">
                <input type="password" id="llmApiKey" placeholder="${hasLocalKey ? '••••••••  (guardada no browser)' : 'Insere a tua chave API...'}" autocomplete="off">
                <button class="btn-icon-inline" onclick="App.toggleApiKeyVisibility()" title="Mostrar/Esconder">👁️</button>
              </div>
              <small class="field-hint">🔐 A chave API é encriptada e guardada apenas no teu browser. Nunca é armazenada no servidor.</small>
              ${keyStatusHtml ? `<small class="field-hint">${keyStatusHtml}</small>` : ''}
            </div>

            <div class="form-group" id="llmPinGroup">
              <label for="llmPin">PIN de proteção</label>
              <input type="password" id="llmPin" placeholder="${hasLocalKey ? 'PIN atual (para atualizar a chave)' : 'Escolhe um PIN para proteger a chave...'}" inputmode="text" autocomplete="off">
              <small class="field-hint">O PIN encripta a tua chave API. Precisarás dele em cada sessão.</small>
            </div>

            <div class="form-group">
              <label for="llmModel">Modelo</label>
              <div class="model-input-group">
                <input type="text" id="llmModel" placeholder="Nome do modelo..." value="${this.escapeHtml(currentCfg.llmModel || '')}" list="modelSuggestions">
                <datalist id="modelSuggestions"></datalist>
              </div>
            </div>

            <div class="settings-actions">
              <button class="btn btn-secondary" onclick="App.testLlmConnection()" id="testBtn">
                🔌 Testar Ligação
              </button>
              <button class="btn btn-primary" onclick="App.saveLlmConfig()">
                💾 Guardar
              </button>
            </div>

            <div id="testResult" class="test-result" style="display:none"></div>
          </div>

          ${!currentCfg.usingDefault ? `
          <div class="settings-reset">
            <button class="btn btn-small btn-danger" onclick="App.resetLlmConfig()">
              🗑️ Remover configuração personalizada
            </button>
            <small>Volta a usar a predefinição do servidor</small>
          </div>` : ''}
        </div>
      </div>
    `);

    // Trigger initial provider field update
    this.onProviderChange();
  },

  onProviderChange() {
    const select = document.getElementById('llmProvider');
    const fields = document.getElementById('llmConfigFields');
    const provider = select?.value || '';

    if (!provider) {
      fields.style.display = 'none';
      return;
    }
    fields.style.display = 'block';

    const preset = (this._llmProviders || []).find(p => p.id === provider);
    if (!preset) return;

    // Update URL field
    const urlInput = document.getElementById('llmUrl');
    const urlHint = document.getElementById('llmUrlHint');
    const urlGroup = document.getElementById('llmUrlGroup');
    const apiKeyGroup = document.getElementById('llmApiKeyGroup');

    // Pre-fill URL if empty or different provider selected
    if (!urlInput.value || (this._llmCurrentCfg.provider !== provider)) {
      urlInput.value = preset.defaultUrl || '';
    }
    urlInput.placeholder = preset.urlPlaceholder || preset.defaultUrl || 'URL do API...';

    if (preset.defaultUrl && provider !== 'custom' && provider !== 'azure') {
      urlHint.textContent = `Predefinição: ${preset.defaultUrl}`;
    } else {
      urlHint.textContent = preset.urlPlaceholder ? `Exemplo: ${preset.urlPlaceholder}` : '';
    }

    // Show/hide API key field and PIN field
    apiKeyGroup.style.display = preset.requiresApiKey ? 'block' : 'none';
    const pinGroup = document.getElementById('llmPinGroup');
    if (pinGroup) pinGroup.style.display = preset.requiresApiKey ? 'block' : 'none';

    // Update model suggestions
    const datalist = document.getElementById('modelSuggestions');
    datalist.innerHTML = preset.models.map(m => `<option value="${m}">`).join('');

    // Pre-fill model if empty
    const modelInput = document.getElementById('llmModel');
    if (!modelInput.value && preset.models.length > 0) {
      modelInput.value = preset.models[0];
    }
  },

  toggleApiKeyVisibility() {
    const input = document.getElementById('llmApiKey');
    if (input) input.type = input.type === 'password' ? 'text' : 'password';
  },

  async testLlmConnection() {
    const provider = document.getElementById('llmProvider')?.value;
    if (!provider) return;

    const btn = document.getElementById('testBtn');
    const result = document.getElementById('testResult');
    btn.disabled = true;
    btn.textContent = '⏳ A testar...';
    result.style.display = 'none';

    try {
      // Use the freshly-typed key for testing, or the already-unlocked one
      const apiKeyInput = document.getElementById('llmApiKey')?.value || this._llmApiKey || '';
      const body = {
        provider,
        llmUrl: document.getElementById('llmUrl')?.value || '',
        llmModel: document.getElementById('llmModel')?.value || '',
      };

      // Send API key via header, not body
      const extraHeaders = {};
      if (apiKeyInput) {
        extraHeaders['X-LLM-Key'] = apiKeyInput;
      }

      const res = await this.api(`/api/accounts/${this.accountId}/llm-config/test`, {
        method: 'POST',
        body,
        headers: extraHeaders,
      });

      result.style.display = 'block';
      if (res.ok) {
        result.className = 'test-result test-success';
        result.innerHTML = '✅ Ligação bem sucedida!' +
          (res.models ? `<br><small>Modelos disponíveis: ${res.models.slice(0, 5).join(', ')}${res.models.length > 5 ? '...' : ''}</small>` : '');
      } else {
        result.className = 'test-result test-fail';
        result.innerHTML = `❌ Falha na ligação: ${this.escapeHtml(res.error || 'Erro desconhecido')}`;
      }
    } catch (err) {
      result.style.display = 'block';
      result.className = 'test-result test-fail';
      result.innerHTML = `❌ Erro: ${this.escapeHtml(err.message)}`;
    } finally {
      btn.disabled = false;
      btn.textContent = '🔌 Testar Ligação';
    }
  },

  async saveLlmConfig() {
    const provider = document.getElementById('llmProvider')?.value;
    if (!provider) {
      // User selected default, reset config
      await this.resetLlmConfig();
      return;
    }

    const apiKeyInput = document.getElementById('llmApiKey')?.value || '';
    const pinInput    = document.getElementById('llmPin')?.value || '';
    const preset = (this._llmProviders || []).find(p => p.id === provider);
    const needsKey = preset?.requiresApiKey;

    // If user typed a new API key, require a PIN to encrypt it
    if (apiKeyInput && needsKey) {
      if (!pinInput) {
        alert('⚠️ Insere um PIN para proteger a tua chave API.');
        document.getElementById('llmPin')?.focus();
        return;
      }
      try {
        const blob = await KeyVault.encrypt(apiKeyInput, pinInput);
        KeyVault.save(this.accountId, blob);
        this._llmApiKey = apiKeyInput; // keep in memory for the session
      } catch (err) {
        alert('❌ Erro ao encriptar a chave: ' + err.message);
        return;
      }
    }

    // Save provider/URL/model to the server (no API key!)
    const body = {
      provider,
      llmUrl: document.getElementById('llmUrl')?.value || '',
      llmModel: document.getElementById('llmModel')?.value || '',
    };

    try {
      await this.api(`/api/accounts/${this.accountId}/llm-config`, {
        method: 'PUT',
        body,
      });
      alert('✅ Configuração LLM guardada com sucesso!');
      this.showLlmSettings();
    } catch (err) {
      alert('❌ Erro ao guardar: ' + err.message);
    }
  },

  // Unlock API key from the settings page
  async unlockApiKeyFromSettings() {
    const ok = await this.unlockApiKey();
    if (ok) this.showLlmSettings(); // refresh to show updated status
  },

  async resetLlmConfig() {
    if (!confirm('Tens a certeza que queres remover a configuração personalizada e usar a predefinição do servidor?')) return;
    try {
      await this.api(`/api/accounts/${this.accountId}/llm-config`, { method: 'DELETE' });
      // Also remove the locally stored encrypted key
      KeyVault.remove(this.accountId);
      this._llmApiKey = null;
      alert('✅ Configuração removida. A usar predefinição do servidor.');
      this.showLlmSettings();
    } catch (err) {
      alert('❌ Erro: ' + err.message);
    }
  }
};

// ─── Carregar vozes para síntese de voz ────────────────────
if ('speechSynthesis' in window) {
  speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
  speechSynthesis.getVoices();
}

// ─── Iniciar Aplicação ─────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => App.init());
