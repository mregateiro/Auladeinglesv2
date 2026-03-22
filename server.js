const express      = require('express');
const cookieParser = require('cookie-parser');
const path         = require('path');
const fs           = require('fs');
const https        = require('https');
const { OAuth2Client } = require('google-auth-library');
const config       = require('./config');
const db           = require('./database');
const llm          = require('./llm');
const generator    = require('./generator');

const app  = express();
const PORT = config.port;
const SESSION_TTL_MS = config.sessionTtlDays * 24 * 60 * 60 * 1000;
const googleClient = config.googleClientId ? new OAuth2Client(config.googleClientId) : null;

if (config.trustProxy) {
  app.set('trust proxy', 1);
}

app.use(express.json());
app.use(cookieParser());

app.use((req, res, next) => {
  const token = req.cookies[config.sessionCookieName];
  if (!token) return next();

  const session = db.getSession(token);
  if (!session) {
    res.clearCookie(config.sessionCookieName, { path: '/' });
    return next();
  }

  db.touchSession(token, SESSION_TTL_MS);
  req.authSession = session;
  req.authUser = db.getUserById(session.user_id);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Load courses from courses/*.json ──────────────────────
const coursesDir = path.join(__dirname, 'courses');
const courses = {};

if (fs.existsSync(coursesDir)) {
  for (const file of fs.readdirSync(coursesDir).filter(f => f.endsWith('.json'))) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(coursesDir, file), 'utf-8'));
      courses[raw.id] = raw;
    } catch (e) {
      console.error(`[COURSES] Failed to load ${file}:`, e.message);
    }
  }
}

function getCourse(courseId) { return courses[courseId] || null; }
function getModule(course, moduleId) { return course.modules.find(m => m.id === moduleId) || null; }

function serializeUser(user, options = {}) {
  if (!user) return null;
  const data = {
    id: user.id,
    name: user.name,
    avatar: user.avatar,
    picture: user.picture || null,
    authProvider: user.auth_provider || 'local',
    hasPin: Boolean(user.pin),
    createdAt: user.created_at,
    lastLogin: user.last_login,
  };

  if (options.includeEmail) {
    data.email = user.email || null;
  }

  return data;
}

function isSecureRequest(req) {
  return config.secureCookies || req.secure || req.headers['x-forwarded-proto'] === 'https';
}

function setSessionCookie(req, res, token) {
  res.cookie(config.sessionCookieName, token, {
    maxAge: SESSION_TTL_MS,
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(config.sessionCookieName, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
  });
}

function createUserSession(req, res, user, provider) {
  const { token } = db.createSession(user.id, SESSION_TTL_MS, provider);
  setSessionCookie(req, res, token);
}

function requireAuth(req, res, next) {
  if (!req.authUser) return res.status(401).json({ error: 'Authentication required' });
  next();
}

function requireSameUser(req, res, next) {
  if (!req.authUser) return res.status(401).json({ error: 'Authentication required' });
  if (req.authUser.id !== Number(req.params.id)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// ═══════════════════════════════════════════════════════════════
// USERS API
// ═══════════════════════════════════════════════════════════════

app.get('/api/users', (req, res) => {
  const users = db.getUsers().map(user => {
    const streak = db.getStreak(user.id);
    const completedLessons = db.completedCount(user.id);
    return {
      ...serializeUser(user),
      totalStars: streak.total_stars || 0,
      currentStreak: streak.current_streak || 0,
      completedLessons
    };
  });
  res.json(users);
});

app.post('/api/users', (req, res) => {
  const { name, avatar, pin } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  try {
    const user = db.createUser(name.trim(), avatar || '🧒', pin || null);
    res.json(serializeUser(user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users/:id/login', (req, res) => {
  const user = db.getUserById(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  if ((user.auth_provider || 'local') !== 'local') {
    return res.status(400).json({ error: 'Use Google sign-in for this account' });
  }
  if (user.pin && user.pin !== req.body.pin) {
    return res.status(401).json({ error: 'Wrong PIN' });
  }
  db.touchLogin(user.id);
  createUserSession(req, res, user, 'local');
  res.json(serializeUser(user));
});

app.get('/api/auth/config', (req, res) => {
  res.json({
    googleEnabled: Boolean(config.googleClientId),
    googleClientId: config.googleClientId || null,
  });
});

app.get('/api/auth/session', (req, res) => {
  if (!req.authUser) return res.status(401).json({ error: 'No active session' });
  res.json({ user: serializeUser(req.authUser, { includeEmail: true }) });
});

app.post('/api/auth/google', async (req, res) => {
  if (!googleClient || !config.googleClientId) {
    return res.status(503).json({ error: 'Google login is not configured' });
  }

  const credential = req.body?.credential;
  if (!credential) {
    return res.status(400).json({ error: 'Missing Google credential' });
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: config.googleClientId,
    });
    const payload = ticket.getPayload();

    if (!payload?.sub || !payload?.email || !payload.email_verified) {
      return res.status(401).json({ error: 'Google account is missing a verified email' });
    }

    const user = db.upsertGoogleUser({
      googleId: payload.sub,
      email: payload.email,
      name: payload.name || payload.email,
      picture: payload.picture || null,
    });

    createUserSession(req, res, user, 'google');
    res.json({ user: serializeUser(user, { includeEmail: true }) });
  } catch (err) {
    console.error('[AUTH][GOOGLE]', err.message);
    res.status(401).json({ error: 'Google sign-in failed' });
  }
});

app.delete('/api/users/:id', (req, res) => {
  db.deleteUser(Number(req.params.id));
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════
// COURSES API
// ═══════════════════════════════════════════════════════════════

app.get('/api/courses', (req, res) => {
  const list = Object.values(courses).map(c => ({
    id: c.id,
    title: c.title,
    titlePt: c.titlePt,
    icon: c.icon,
    description: c.description,
    descriptionPt: c.descriptionPt,
    level: c.level,
    ageGroup: c.ageGroup,
    modulesCount: c.modules.length,
    speechLang: c.speechLang
  }));
  res.json(list);
});

app.get('/api/courses/:courseId', (req, res) => {
  const course = getCourse(req.params.courseId);
  if (!course) return res.status(404).json({ error: 'Course not found' });
  res.json(course);
});

// ═══════════════════════════════════════════════════════════════
// MODULES & LESSONS API  (course-aware)
// ═══════════════════════════════════════════════════════════════

// List modules for a course, with user progress
app.get('/api/courses/:courseId/modules', (req, res) => {
  const course = getCourse(req.params.courseId);
  if (!course) return res.status(404).json({ error: 'Course not found' });

  const userId = req.authUser?.id || null;

  const modulesWithProgress = course.modules.map(mod => {
    const lessons = generator.getLessonList(course, mod);

    const lessonsWithProgress = lessons.map(lesson => {
      let progress = null;
      if (userId) {
        progress = db.getProgress(userId, mod.id, lesson.id);
      }
      return {
        ...lesson,
        completed: progress?.completed || false,
        score: progress?.score || 0,
        maxScore: progress?.max_score || 0,
        attempts: progress?.attempts || 0
      };
    });

    const completedCount = lessonsWithProgress.filter(l => l.completed).length;
    return {
      id: mod.id,
      title: mod.title,
      titlePt: mod.titlePt,
      icon: mod.icon,
      order: mod.order,
      objectives: mod.objectives,
      lessonsCount: lessonsWithProgress.length,
      completedCount,
      progress: Math.round((completedCount / lessonsWithProgress.length) * 100),
      lessons: lessonsWithProgress
    };
  });

  res.json(modulesWithProgress);
});

// Get (or generate) a specific lesson
app.get('/api/courses/:courseId/modules/:moduleId/lessons/:lessonId', async (req, res) => {
  try {
    const course = getCourse(req.params.courseId);
    if (!course) return res.status(404).json({ error: 'Course not found' });

    const mod = getModule(course, req.params.moduleId);
    if (!mod) return res.status(404).json({ error: 'Module not found' });

    const lesson = await generator.getLesson(course, mod, req.params.lessonId);
    res.json(lesson);
  } catch (err) {
    console.error('[GENERATE]', err.message);
    res.status(500).json({ error: 'Failed to generate lesson', details: err.message });
  }
});

// Force regenerate a lesson (clears cache and regenerates)
app.post('/api/courses/:courseId/modules/:moduleId/lessons/:lessonId/regenerate', async (req, res) => {
  try {
    const course = getCourse(req.params.courseId);
    if (!course) return res.status(404).json({ error: 'Course not found' });

    const mod = getModule(course, req.params.moduleId);
    if (!mod) return res.status(404).json({ error: 'Module not found' });

    const lessonId = req.params.lessonId;
    // Determine cache key from lesson ID
    const quizMatch  = lessonId.match(/^(.+)-quiz-(\d+)$/);
    const vocabMatch = lessonId.match(/^(.+)-vocab-(\d+)$/);
    const speakMatch = lessonId.match(/^(.+)-speak-(\d+)$/);

    if (quizMatch) {
      db.clearContent(`quiz:${course.id}:${mod.id}:${quizMatch[2]}`);
    } else if (vocabMatch) {
      db.clearContent(`vocab:${course.id}:${mod.id}:${vocabMatch[2]}`);
    } else if (speakMatch) {
      db.clearContent(`speak:${course.id}:${mod.id}:${speakMatch[2]}`);
    }

    const lesson = await generator.getLesson(course, mod, lessonId);
    res.json(lesson);
  } catch (err) {
    console.error('[REGENERATE]', err.message);
    res.status(500).json({ error: 'Failed to regenerate lesson', details: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// PROGRESS API
// ═══════════════════════════════════════════════════════════════

app.post('/api/progress', (req, res) => {
  if (!req.authUser) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { moduleId, lessonId, score, maxScore } = req.body;
  if (!moduleId || !lessonId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  const result = db.saveProgress(req.authUser.id, moduleId, lessonId, score, maxScore);
  res.json(result);
});

// ═══════════════════════════════════════════════════════════════
// STATS API
// ═══════════════════════════════════════════════════════════════

app.get('/api/users/:id/stats', requireSameUser, (req, res) => {
  const userId = Number(req.params.id);
  const user = db.getUserById(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const streak = db.getStreak(userId);
  const completedLessons = db.completedCount(userId);
  const totalAttempts = db.totalAttempts(userId);
  const vocabMastered = db.vocabMasteredCount(userId);
  const vocabTotal = db.vocabTotalCount(userId);
  const recentActivity = db.recentActivity(userId);

  // Count total lessons across all courses (vocab per topic + speaking + quiz per module)
  const totalLessons = Object.values(courses).reduce((sum, c) =>
    sum + c.modules.reduce((s2, m) => {
      const isLanguage = c.targetLanguage !== c.nativeLanguage;
      return s2 + m.topics.length + (isLanguage ? 1 : 0) + 1; // +1 speaking (lang only) +1 quiz
    }, 0), 0
  );

  res.json({
    user,
    streak,
    totalLessons,
    completedLessons,
    totalAttempts,
    vocabMastered,
    vocabTotal,
    recentActivity
  });
});

// ═══════════════════════════════════════════════════════════════
// VOCABULARY API
// ═══════════════════════════════════════════════════════════════

app.post('/api/vocabulary', (req, res) => {
  if (!req.authUser) return res.status(401).json({ error: 'Authentication required' });
  const { word, translation, moduleId, correct } = req.body;
  if (!word) return res.status(400).json({ error: 'Missing fields' });
  db.upsertVocab(req.authUser.id, word, translation, moduleId, correct);
  res.json({ success: true });
});

app.get('/api/users/:id/vocabulary', requireSameUser, (req, res) => {
  res.json(db.getVocabulary(Number(req.params.id)));
});

// ═══════════════════════════════════════════════════════════════
// HEALTH / LLM STATUS
// ═══════════════════════════════════════════════════════════════

app.get('/api/health', async (req, res) => {
  const llmOk = await llm.ping();
  res.json({
    status: 'ok',
    llm: {
      provider: config.provider,
      model: config.llmModel,
      url: config.llmUrl,
      available: llmOk
    },
    courses: Object.keys(courses).length
  });
});

// Admin: clear generated content cache
app.post('/api/admin/clear-cache', (req, res) => {
  const { courseId } = req.body;
  if (courseId) {
    db.clearContent(`vocab:${courseId}:`);
    db.clearContent(`quiz:${courseId}:`);
  } else {
    db.clearContent();
  }
  res.json({ success: true, message: courseId ? `Cache cleared for ${courseId}` : 'All cache cleared' });
});

// ═══════════════════════════════════════════════════════════════
// LOGOUT & SPA FALLBACK
// ═══════════════════════════════════════════════════════════════

app.post('/api/logout', (req, res) => {
  const token = req.cookies[config.sessionCookieName];
  if (token) db.deleteSession(token);
  clearSessionCookie(res);
  res.json({ success: true });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ═══════════════════════════════════════════════════════════════
// START SERVER (HTTP + HTTPS for Speech Recognition on LAN)
// ═══════════════════════════════════════════════════════════════

function getLocalIP() {
  const nets = require('os').networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

async function generateSelfSignedCert() {
  const certDir = path.join(__dirname, 'certs');
  const keyPath  = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }

  try {
    const selfsigned = require('selfsigned');
    const localIP = getLocalIP();
    const attrs = [{ name: 'commonName', value: 'AulaDeIngles' }];
    const pems = await selfsigned.generate(attrs, {
      algorithm: 'sha256',
      days: 3650,
      keySize: 2048,
      extensions: [
        { name: 'subjectAltName', altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
          { type: 7, ip: localIP },
        ]}
      ]
    });

    if (!fs.existsSync(certDir)) fs.mkdirSync(certDir, { recursive: true });
    fs.writeFileSync(keyPath, pems.private);
    fs.writeFileSync(certPath, pems.cert);
    console.log('🔐 Self-signed HTTPS certificate generated in certs/');
    return { key: pems.private, cert: pems.cert };
  } catch (e) {
    console.log('⚠️  Could not generate HTTPS cert:', e.message);
    console.log('   Speech Recognition needs HTTPS on LAN. On localhost it works with HTTP.');
    return null;
  }
}

const localIP = getLocalIP();

// HTTP server (always)
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎓 Learning Platform running at http://localhost:${PORT}`);
  console.log(`   LAN: http://${localIP}:${PORT}`);
  console.log(`📚 ${Object.keys(courses).length} course(s) loaded: ${Object.keys(courses).join(', ')}`);
  console.log(`🤖 LLM: ${config.provider} → ${config.llmUrl} (${config.llmModel})`);
});

// HTTPS server (for Speech Recognition on LAN devices)
(async () => {
  const sslOpts = await generateSelfSignedCert();
  if (sslOpts) {
    const HTTPS_PORT = Number(PORT) + 443;
    https.createServer(sslOpts, app).listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`🔐 HTTPS running at https://${localIP}:${HTTPS_PORT}`);
      console.log(`   📱 No telemóvel usa: https://${localIP}:${HTTPS_PORT}`);
      console.log(`   (Aceita o certificado auto-assinado no browser)`);
    });
  }
})();
