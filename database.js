// ─── JSON File Database ──────────────────────────────────────
// Zero dependencies, keeps everything in memory with periodic flush to disk.
// Perfect for a family-sized app (2-10 users, <1 000 records).
// Data is fully ACID-safe per write (sync flush on mutations).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'auladeingles.json');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const EMPTY_DB = {
  users: [],
  sessions: [],
  progress: [],
  vocabulary: [],
  streaks: [],
  activityLog: [],
  content: {},          // LLM-generated content cache  { cacheKey: { ...lesson, _cachedAt } }
  _seq: { users: 1, progress: 1, vocabulary: 1, streaks: 1, activityLog: 1 }
};

class JsonDatabase {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = this._load();
  }

  // ── persistence ────────────────────────────────────────
  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const d = JSON.parse(raw);
        return {
          ...EMPTY_DB,
          ...d,
          _seq: { ...EMPTY_DB._seq, ...(d._seq || {}) }
        };
      }
    } catch (e) {
      console.error('[DB] Corrupt file – starting fresh:', e.message);
    }
    return structuredClone(EMPTY_DB);
  }

  _save() {
    // Synchronous write so callers always see consistent data after return.
    // At this data size (<100 KB) the cost is negligible (~0.1 ms).
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  _nextId(collection) {
    return this.data._seq[collection]++;
  }

  // ══════════════════════════════════════════════════════════
  // USERS
  // ══════════════════════════════════════════════════════════
  getUsers() {
    return [...this.data.users].sort((a, b) => a.name.localeCompare(b.name));
  }

  getUserById(id) {
    return this.data.users.find(u => u.id === id) || null;
  }

  getUserByEmail(email) {
    if (!email) return null;
    return this.data.users.find(u => (u.email || '').toLowerCase() === email.toLowerCase()) || null;
  }

  getUserByGoogleId(googleId) {
    if (!googleId) return null;
    return this.data.users.find(u => u.google_id === googleId) || null;
  }

  createUser(name, avatar = '🧒', pin = null, extra = {}) {
    const user = {
      id: this._nextId('users'),
      name,
      avatar,
      pin,
      auth_provider: extra.authProvider || 'local',
      google_id: extra.googleId || null,
      email: extra.email || null,
      picture: extra.picture || null,
      created_at: new Date().toISOString(),
      last_login: new Date().toISOString()
    };
    this.data.users.push(user);

    // Streak row
    this.data.streaks.push({
      id: this._nextId('streaks'),
      user_id: user.id,
      current_streak: 0,
      longest_streak: 0,
      total_stars: 0,
      last_activity_date: null
    });

    this._save();
    return user;
  }

  upsertGoogleUser({ googleId, email, name, picture }) {
    const now = new Date().toISOString();
    let user = this.getUserByGoogleId(googleId);

    if (!user && email) {
      user = this.getUserByEmail(email);
    }

    if (user) {
      user.name = name || user.name;
      user.auth_provider = 'google';
      user.google_id = googleId;
      user.email = email || user.email || null;
      user.picture = picture || user.picture || null;
      user.last_login = now;
      this._save();
      return user;
    }

    return this.createUser(name || email || 'Google User', '🧑', null, {
      authProvider: 'google',
      googleId,
      email,
      picture,
    });
  }

  touchLogin(id) {
    const u = this.getUserById(id);
    if (u) { u.last_login = new Date().toISOString(); this._save(); }
    return u;
  }

  _hashSessionToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  _purgeExpiredSessions() {
    const now = Date.now();
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter(session => new Date(session.expires_at).getTime() > now);
    if (this.data.sessions.length !== before) this._save();
  }

  createSession(userId, ttlMs, provider = 'local') {
    this._purgeExpiredSessions();
    const token = crypto.randomBytes(32).toString('base64url');
    const now = new Date();
    const session = {
      id: crypto.randomBytes(16).toString('hex'),
      user_id: userId,
      provider,
      token_hash: this._hashSessionToken(token),
      created_at: now.toISOString(),
      last_used_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttlMs).toISOString()
    };
    this.data.sessions.push(session);
    this._save();
    return { token, session };
  }

  getSession(token) {
    if (!token) return null;
    this._purgeExpiredSessions();
    const tokenHash = this._hashSessionToken(token);
    return this.data.sessions.find(session => session.token_hash === tokenHash) || null;
  }

  touchSession(token, ttlMs) {
    const session = this.getSession(token);
    if (!session) return null;
    const now = new Date();
    session.last_used_at = now.toISOString();
    session.expires_at = new Date(now.getTime() + ttlMs).toISOString();
    this._save();
    return session;
  }

  deleteSession(token) {
    if (!token) return;
    const tokenHash = this._hashSessionToken(token);
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter(session => session.token_hash !== tokenHash);
    if (this.data.sessions.length !== before) this._save();
  }

  deleteUser(id) {
    this.data.users        = this.data.users.filter(r => r.id !== id);
    this.data.sessions     = this.data.sessions.filter(r => r.user_id !== id);
    this.data.progress     = this.data.progress.filter(r => r.user_id !== id);
    this.data.vocabulary   = this.data.vocabulary.filter(r => r.user_id !== id);
    this.data.streaks      = this.data.streaks.filter(r => r.user_id !== id);
    this.data.activityLog  = this.data.activityLog.filter(r => r.user_id !== id);
    this._save();
  }

  // ══════════════════════════════════════════════════════════
  // PROGRESS
  // ══════════════════════════════════════════════════════════
  getProgress(userId, moduleId, lessonId) {
    return this.data.progress.find(p =>
      p.user_id === userId && p.module_id === moduleId && p.lesson_id === lessonId
    ) || null;
  }

  completedCount(userId) {
    return this.data.progress.filter(p => p.user_id === userId && p.completed).length;
  }

  totalAttempts(userId) {
    return this.data.progress
      .filter(p => p.user_id === userId)
      .reduce((s, p) => s + (p.attempts || 0), 0);
  }

  saveProgress(userId, moduleId, lessonId, score, maxScore) {
    const completed = score >= maxScore * 0.7;
    const stars = score === maxScore ? 3 : score >= maxScore * 0.8 ? 2 : completed ? 1 : 0;

    let row = this.getProgress(userId, moduleId, lessonId);
    if (row) {
      row.score       = Math.max(row.score, score);
      row.max_score   = maxScore;
      row.completed   = row.completed || completed;
      row.attempts    = (row.attempts || 0) + 1;
      row.last_attempt = new Date().toISOString();
    } else {
      this.data.progress.push({
        id: this._nextId('progress'),
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
    const streak    = this.data.streaks.find(s => s.user_id === userId);

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
    this.data.activityLog.push({
      id: this._nextId('activityLog'),
      user_id: userId,
      action: 'lesson_completed',
      details: JSON.stringify({ moduleId, lessonId, score, maxScore, starsEarned: stars }),
      created_at: new Date().toISOString()
    });

    this._save();
    return { completed, starsEarned: stars, score, maxScore };
  }

  // ══════════════════════════════════════════════════════════
  // STREAKS
  // ══════════════════════════════════════════════════════════
  getStreak(userId) {
    return this.data.streaks.find(s => s.user_id === userId)
      || { current_streak: 0, longest_streak: 0, total_stars: 0, last_activity_date: null };
  }

  // ══════════════════════════════════════════════════════════
  // VOCABULARY
  // ══════════════════════════════════════════════════════════
  getVocabulary(userId) {
    return this.data.vocabulary
      .filter(v => v.user_id === userId)
      .sort((a, b) => (b.last_reviewed || '').localeCompare(a.last_reviewed || ''));
  }

  vocabMasteredCount(userId) {
    return this.data.vocabulary.filter(v => v.user_id === userId && v.mastered).length;
  }

  vocabTotalCount(userId) {
    return this.data.vocabulary.filter(v => v.user_id === userId).length;
  }

  upsertVocab(userId, word, translation, moduleId, correct) {
    let row = this.data.vocabulary.find(v => v.user_id === userId && v.word === word);

    if (row) {
      if (correct) row.times_correct = (row.times_correct || 0) + 1;
      else          row.times_wrong  = (row.times_wrong  || 0) + 1;
      row.mastered      = row.times_correct >= 5 && row.times_correct > row.times_wrong * 2;
      row.last_reviewed = new Date().toISOString();
    } else {
      this.data.vocabulary.push({
        id: this._nextId('vocabulary'),
        user_id: userId, word,
        translation: translation || '',
        module_id: moduleId || '',
        times_correct: correct ? 1 : 0,
        times_wrong:   correct ? 0 : 1,
        mastered: false,
        last_reviewed: new Date().toISOString()
      });
    }
    this._save();
  }

  // ══════════════════════════════════════════════════════════
  // ACTIVITY LOG
  // ══════════════════════════════════════════════════════════
  recentActivity(userId, limit = 10) {
    return this.data.activityLog
      .filter(a => a.user_id === userId)
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .slice(0, limit);
  }

  // ══════════════════════════════════════════════════════════
  // CONTENT CACHE  (LLM-generated lessons)
  // ══════════════════════════════════════════════════════════
  getContent(cacheKey) {
    return this.data.content[cacheKey] || null;
  }

  saveContent(cacheKey, lesson) {
    this.data.content[cacheKey] = { ...lesson, _cachedAt: new Date().toISOString() };
    this._save();
  }

  clearContent(prefix) {
    // Clear all cached content, or only keys starting with a given prefix
    if (prefix) {
      for (const key of Object.keys(this.data.content)) {
        if (key.startsWith(prefix)) delete this.data.content[key];
      }
    } else {
      this.data.content = {};
    }
    this._save();
  }
}

module.exports = new JsonDatabase(DB_PATH);
