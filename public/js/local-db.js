// ─── Local Database (localStorage) ────────────────────────────
// Browser-side replacement for the server's JSON file database.
// Uses localStorage with a single JSON key — same approach as the server
// uses a single JSON file. Perfect for a family-sized app (2-10 users).

const LocalDB = (() => {
  const STORAGE_KEY = 'auladeingles_db';

  const EMPTY_DB = {
    accounts: [],
    users: [],
    progress: [],
    vocabulary: [],
    streaks: [],
    activityLog: [],
    content: {},
    llmConfigs: [],
    _seq: { accounts: 1, users: 1, progress: 1, vocabulary: 1, streaks: 1, activityLog: 1, llmConfigs: 1 }
  };

  // structuredClone fallback for older Android WebView versions
  const _clone = typeof structuredClone === 'function'
    ? structuredClone
    : (obj) => JSON.parse(JSON.stringify(obj));

  function _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        return {
          ...EMPTY_DB,
          ...d,
          _seq: { ...EMPTY_DB._seq, ...(d._seq || {}) }
        };
      }
    } catch (e) {
      console.error('[LocalDB] Corrupt data – starting fresh:', e.message);
    }
    return _clone(EMPTY_DB);
  }

  let data = _load();

  function _save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.error('[LocalDB] Failed to save:', e.message);
    }
  }

  function _nextId(collection) {
    return data._seq[collection]++;
  }

  // ══════════════════════════════════════════════════════════
  // USERS
  // ══════════════════════════════════════════════════════════
  function getUsers() {
    return [...data.users].sort((a, b) => a.name.localeCompare(b.name));
  }

  function getUserById(id) {
    return data.users.find(u => u.id === id) || null;
  }

  function createUser(name, avatar, pin) {
    const now = new Date().toISOString();
    const user = {
      id: _nextId('users'),
      name,
      avatar: avatar || '🧒',
      pin: pin || null,
      auth_provider: 'local',
      account_id: null,
      created_at: now,
      last_login: now
    };
    data.users.push(user);

    data.streaks.push({
      id: _nextId('streaks'),
      user_id: user.id,
      current_streak: 0,
      longest_streak: 0,
      total_stars: 0,
      last_activity_date: null
    });

    _save();
    return user;
  }

  function touchLogin(id) {
    const u = getUserById(id);
    if (u) { u.last_login = new Date().toISOString(); _save(); }
    return u;
  }

  function deleteUser(id) {
    data.users        = data.users.filter(r => r.id !== id);
    data.progress     = data.progress.filter(r => r.user_id !== id);
    data.vocabulary   = data.vocabulary.filter(r => r.user_id !== id);
    data.streaks      = data.streaks.filter(r => r.user_id !== id);
    data.activityLog  = data.activityLog.filter(r => r.user_id !== id);
    _save();
  }

  // ══════════════════════════════════════════════════════════
  // PROGRESS
  // ══════════════════════════════════════════════════════════
  function getProgress(userId, moduleId, lessonId) {
    return data.progress.find(p =>
      p.user_id === userId && p.module_id === moduleId && p.lesson_id === lessonId
    ) || null;
  }

  function completedCount(userId) {
    return data.progress.filter(p => p.user_id === userId && p.completed).length;
  }

  function totalAttempts(userId) {
    return data.progress
      .filter(p => p.user_id === userId)
      .reduce((s, p) => s + (p.attempts || 0), 0);
  }

  function saveProgress(userId, moduleId, lessonId, score, maxScore) {
    const completed = score >= maxScore * 0.7;
    const stars = score === maxScore ? 3 : score >= maxScore * 0.8 ? 2 : completed ? 1 : 0;

    let row = getProgress(userId, moduleId, lessonId);
    if (row) {
      row.score       = Math.max(row.score, score);
      row.max_score   = maxScore;
      row.completed   = row.completed || completed;
      row.attempts    = (row.attempts || 0) + 1;
      row.last_attempt = new Date().toISOString();
    } else {
      data.progress.push({
        id: _nextId('progress'),
        user_id: userId,
        module_id: moduleId,
        lesson_id: lessonId,
        score, max_score: maxScore,
        completed,
        attempts: 1,
        last_attempt: new Date().toISOString()
      });
    }

    // ── streak logic ──
    const today     = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const streak    = data.streaks.find(s => s.user_id === userId);

    if (streak) {
      if (streak.last_activity_date !== today) {
        streak.current_streak = (streak.last_activity_date === yesterday)
          ? streak.current_streak + 1
          : 1;
      }
      streak.longest_streak     = Math.max(streak.current_streak, streak.longest_streak);
      streak.total_stars        = (streak.total_stars || 0) + stars;
      streak.last_activity_date = today;
    }

    // ── activity log ──
    data.activityLog.push({
      id: _nextId('activityLog'),
      user_id: userId,
      action: 'lesson_completed',
      details: JSON.stringify({ moduleId, lessonId, score, maxScore, starsEarned: stars }),
      created_at: new Date().toISOString()
    });

    _save();
    return { completed, starsEarned: stars, score, maxScore };
  }

  // ══════════════════════════════════════════════════════════
  // STREAKS
  // ══════════════════════════════════════════════════════════
  function getStreak(userId) {
    return data.streaks.find(s => s.user_id === userId)
      || { current_streak: 0, longest_streak: 0, total_stars: 0, last_activity_date: null };
  }

  // ══════════════════════════════════════════════════════════
  // VOCABULARY
  // ══════════════════════════════════════════════════════════
  function getVocabulary(userId) {
    return data.vocabulary
      .filter(v => v.user_id === userId)
      .sort((a, b) => (b.last_reviewed || '').localeCompare(a.last_reviewed || ''));
  }

  function vocabMasteredCount(userId) {
    return data.vocabulary.filter(v => v.user_id === userId && v.mastered).length;
  }

  function vocabTotalCount(userId) {
    return data.vocabulary.filter(v => v.user_id === userId).length;
  }

  function upsertVocab(userId, word, translation, moduleId, correct) {
    let row = data.vocabulary.find(v => v.user_id === userId && v.word === word);

    if (row) {
      if (correct) row.times_correct = (row.times_correct || 0) + 1;
      else          row.times_wrong  = (row.times_wrong  || 0) + 1;
      row.mastered      = row.times_correct >= 5 && row.times_correct > row.times_wrong * 2;
      row.last_reviewed = new Date().toISOString();
    } else {
      data.vocabulary.push({
        id: _nextId('vocabulary'),
        user_id: userId, word,
        translation: translation || '',
        module_id: moduleId || '',
        times_correct: correct ? 1 : 0,
        times_wrong:   correct ? 0 : 1,
        mastered: false,
        last_reviewed: new Date().toISOString()
      });
    }
    _save();
  }

  // ══════════════════════════════════════════════════════════
  // ACTIVITY LOG
  // ══════════════════════════════════════════════════════════
  function recentActivity(userId, limit) {
    return data.activityLog
      .filter(a => a.user_id === userId)
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .slice(0, limit || 10);
  }

  // ══════════════════════════════════════════════════════════
  // CONTENT CACHE (LLM-generated lessons)
  // ══════════════════════════════════════════════════════════
  function getContent(cacheKey) {
    return data.content[cacheKey] || null;
  }

  function saveContent(cacheKey, lesson) {
    data.content[cacheKey] = { ...lesson, _cachedAt: new Date().toISOString() };
    _save();
  }

  function clearContent(prefix) {
    if (prefix) {
      for (const key of Object.keys(data.content)) {
        if (key.startsWith(prefix)) delete data.content[key];
      }
    } else {
      data.content = {};
    }
    _save();
  }

  // ══════════════════════════════════════════════════════════
  // LLM CONFIGS
  // ══════════════════════════════════════════════════════════
  function getLlmConfig() {
    if (!data.llmConfigs) data.llmConfigs = [];
    return data.llmConfigs[0] || null;
  }

  function saveLlmConfig(cfg) {
    if (!data.llmConfigs) data.llmConfigs = [];
    let row = data.llmConfigs[0];
    if (row) {
      row.provider    = cfg.provider;
      row.llm_url     = cfg.llmUrl     || '';
      row.llm_model   = cfg.llmModel   || '';
      row.updated_at  = new Date().toISOString();
    } else {
      row = {
        id: _nextId('llmConfigs'),
        provider:    cfg.provider    || '',
        llm_url:     cfg.llmUrl     || '',
        llm_model:   cfg.llmModel   || '',
        created_at:  new Date().toISOString(),
        updated_at:  new Date().toISOString(),
      };
      data.llmConfigs.push(row);
    }
    _save();
    return row;
  }

  function deleteLlmConfig() {
    data.llmConfigs = [];
    _save();
  }

  // ══════════════════════════════════════════════════════════
  // SESSION (simple localStorage-based current user tracking)
  // ══════════════════════════════════════════════════════════
  function getCurrentUserId() {
    const id = localStorage.getItem('auladeingles_currentUser');
    return id ? Number(id) : null;
  }

  function setCurrentUserId(id) {
    if (id) localStorage.setItem('auladeingles_currentUser', String(id));
    else localStorage.removeItem('auladeingles_currentUser');
  }

  return {
    getUsers, getUserById, createUser, touchLogin, deleteUser,
    getProgress, completedCount, totalAttempts, saveProgress,
    getStreak,
    getVocabulary, vocabMasteredCount, vocabTotalCount, upsertVocab,
    recentActivity,
    getContent, saveContent, clearContent,
    getLlmConfig, saveLlmConfig, deleteLlmConfig,
    getCurrentUserId, setCurrentUserId,
  };
})();
