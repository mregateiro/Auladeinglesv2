// ─── Local API Router ──────────────────────────────────────────
// Intercepts all API calls from app.js and routes them to local
// implementations (LocalDB, LocalLLM, LocalGenerator, CoursesData).
// This replaces the Express server entirely for the Android app.

const LocalAPI = (() => {
  // Course data loaded from bundled CoursesData
  const courses = CoursesData;

  // In standalone mode, all users share a single local "account" for LLM config
  const LOCAL_ACCOUNT_ID = 1;
  const LOCAL_ACCOUNT = { id: LOCAL_ACCOUNT_ID, name: 'Local', email: null, picture: null };

  function getCourse(courseId) { return courses[courseId] || null; }
  function getModule(course, moduleId) { return course.modules.find(m => m.id === moduleId) || null; }

  function serializeUser(user) {
    if (!user) return null;
    return {
      id: user.id,
      name: user.name,
      avatar: user.avatar,
      picture: null,
      authProvider: 'local',
      accountId: null,
      hasPin: Boolean(user.pin),
      createdAt: user.created_at,
      lastLogin: user.last_login,
    };
  }

  // ── URL pattern matcher ──────────────────────────────────
  function matchRoute(method, url) {
    // Strip query string
    const path = url.split('?')[0];
    const m = method.toUpperCase();

    // Static routes
    if (m === 'GET'  && path === '/api/auth/config')          return { handler: 'authConfig' };
    if (m === 'GET'  && path === '/api/auth/session')          return { handler: 'authSession' };
    if (m === 'POST' && path === '/api/auth/google')           return { handler: 'authGoogle' };
    if (m === 'POST' && path === '/api/auth/select-profile')   return { handler: 'selectProfile' };
    if (m === 'POST' && path === '/api/logout')                return { handler: 'logout' };
    if (m === 'GET'  && path === '/api/users')                 return { handler: 'getUsers' };
    if (m === 'POST' && path === '/api/users')                 return { handler: 'createUser' };
    if (m === 'GET'  && path === '/api/courses')               return { handler: 'getCourses' };
    if (m === 'POST' && path === '/api/progress')              return { handler: 'saveProgress' };
    if (m === 'POST' && path === '/api/vocabulary')            return { handler: 'saveVocabulary' };
    if (m === 'GET'  && path === '/api/llm-providers')         return { handler: 'getLlmProviders' };

    // Parametric routes
    let match;

    match = path.match(/^\/api\/users\/(\d+)\/login$/);
    if (m === 'POST' && match) return { handler: 'loginUser', params: { id: Number(match[1]) } };

    match = path.match(/^\/api\/users\/(\d+)$/);
    if (m === 'DELETE' && match) return { handler: 'deleteUser', params: { id: Number(match[1]) } };

    match = path.match(/^\/api\/users\/(\d+)\/stats$/);
    if (m === 'GET' && match) return { handler: 'getUserStats', params: { id: Number(match[1]) } };

    match = path.match(/^\/api\/users\/(\d+)\/vocabulary$/);
    if (m === 'GET' && match) return { handler: 'getUserVocabulary', params: { id: Number(match[1]) } };

    match = path.match(/^\/api\/courses\/([^/]+)$/);
    if (m === 'GET' && match) return { handler: 'getCourse', params: { courseId: match[1] } };

    match = path.match(/^\/api\/courses\/([^/]+)\/modules$/);
    if (m === 'GET' && match) return { handler: 'getModules', params: { courseId: match[1] } };

    match = path.match(/^\/api\/courses\/([^/]+)\/modules\/([^/]+)\/lessons\/([^/]+)\/regenerate$/);
    if (m === 'POST' && match) return { handler: 'regenerateLesson', params: { courseId: match[1], moduleId: match[2], lessonId: match[3] } };

    match = path.match(/^\/api\/courses\/([^/]+)\/modules\/([^/]+)\/lessons\/([^/]+)$/);
    if (m === 'GET' && match) return { handler: 'getLesson', params: { courseId: match[1], moduleId: match[2], lessonId: match[3] } };

    match = path.match(/^\/api\/accounts\/(\d+)\/profiles$/);
    if (m === 'GET' && match)  return { handler: 'getProfiles', params: { id: Number(match[1]) } };
    if (m === 'POST' && match) return { handler: 'createProfile', params: { id: Number(match[1]) } };

    match = path.match(/^\/api\/accounts\/(\d+)\/profiles\/(\d+)$/);
    if (m === 'DELETE' && match) return { handler: 'deleteProfile', params: { accountId: Number(match[1]), profileId: Number(match[2]) } };

    match = path.match(/^\/api\/accounts\/(\d+)\/llm-config\/test$/);
    if (m === 'POST' && match) return { handler: 'testLlmConfig', params: { id: Number(match[1]) } };

    match = path.match(/^\/api\/accounts\/(\d+)\/llm-config$/);
    if (m === 'GET' && match)    return { handler: 'getLlmConfig', params: { id: Number(match[1]) } };
    if (m === 'PUT' && match)    return { handler: 'saveLlmConfig', params: { id: Number(match[1]) } };
    if (m === 'DELETE' && match) return { handler: 'deleteLlmConfig', params: { id: Number(match[1]) } };

    return null;
  }

  // ── Main handler ────────────────────────────────────────
  async function handle(url, options) {
    const method = (options.method || 'GET').toUpperCase();
    const body = options.body || {};
    const route = matchRoute(method, url);

    if (!route) {
      throw new Error(`Unknown API route: ${method} ${url}`);
    }

    const p = route.params || {};

    switch (route.handler) {
      // ── Auth ──
      case 'authConfig':
        return { googleEnabled: false, googleClientId: null };

      case 'authSession': {
        const userId = LocalDB.getCurrentUserId();
        if (!userId) throw new Error('No active session');
        const user = LocalDB.getUserById(userId);
        if (!user) {
          LocalDB.setCurrentUserId(null);
          throw new Error('No active session');
        }
        return {
          account: LOCAL_ACCOUNT,
          user: serializeUser(user),
          needsProfileSelection: false,
        };
      }

      case 'authGoogle':
        throw new Error('Google login is not available in the standalone app');

      case 'selectProfile':
        throw new Error('Profile selection not needed in standalone app');

      case 'logout':
        LocalDB.setCurrentUserId(null);
        return { success: true };

      // ── Users ──
      case 'getUsers': {
        const users = LocalDB.getUsers().map(user => {
          const streak = LocalDB.getStreak(user.id);
          const completedLessons = LocalDB.completedCount(user.id);
          return {
            ...serializeUser(user),
            totalStars: streak.total_stars || 0,
            currentStreak: streak.current_streak || 0,
            completedLessons
          };
        });
        return users;
      }

      case 'createUser': {
        const { name, avatar, pin } = body;
        if (!name || !name.trim()) throw new Error('Name is required');
        const user = LocalDB.createUser(name.trim(), avatar || '🧒', pin || null);
        return serializeUser(user);
      }

      case 'loginUser': {
        const user = LocalDB.getUserById(p.id);
        if (!user) throw new Error('User not found');
        if (user.pin && user.pin !== body.pin) throw new Error('Wrong PIN');
        LocalDB.touchLogin(user.id);
        LocalDB.setCurrentUserId(user.id);
        return serializeUser(user);
      }

      case 'deleteUser': {
        LocalDB.deleteUser(p.id);
        return { success: true };
      }

      // ── Courses ──
      case 'getCourses': {
        return Object.values(courses).map(c => ({
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
      }

      case 'getCourse': {
        const course = getCourse(p.courseId);
        if (!course) throw new Error('Course not found');
        return course;
      }

      case 'getModules': {
        const course = getCourse(p.courseId);
        if (!course) throw new Error('Course not found');

        const userId = LocalDB.getCurrentUserId();

        return course.modules.map(mod => {
          const lessons = LocalGenerator.getLessonList(course, mod);

          const lessonsWithProgress = lessons.map(lesson => {
            let progress = null;
            if (userId) {
              progress = LocalDB.getProgress(userId, mod.id, lesson.id);
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
      }

      case 'getLesson': {
        const course = getCourse(p.courseId);
        if (!course) throw new Error('Course not found');
        const mod = getModule(course, p.moduleId);
        if (!mod) throw new Error('Module not found');
        return await LocalGenerator.getLesson(course, mod, p.lessonId);
      }

      case 'regenerateLesson': {
        const course = getCourse(p.courseId);
        if (!course) throw new Error('Course not found');
        const mod = getModule(course, p.moduleId);
        if (!mod) throw new Error('Module not found');

        const lessonId = p.lessonId;
        const quizMatch  = lessonId.match(/^(.+)-quiz-(\d+)$/);
        const vocabMatch = lessonId.match(/^(.+)-vocab-(\d+)$/);
        const speakMatch = lessonId.match(/^(.+)-speak-(\d+)$/);

        if (quizMatch)  LocalDB.clearContent(`quiz:${course.id}:${mod.id}:${quizMatch[2]}`);
        else if (vocabMatch) LocalDB.clearContent(`vocab:${course.id}:${mod.id}:${vocabMatch[2]}`);
        else if (speakMatch) LocalDB.clearContent(`speak:${course.id}:${mod.id}:${speakMatch[2]}`);

        return await LocalGenerator.getLesson(course, mod, lessonId);
      }

      // ── Progress ──
      case 'saveProgress': {
        const userId = LocalDB.getCurrentUserId();
        if (!userId) throw new Error('Authentication required');
        const { moduleId, lessonId, score, maxScore } = body;
        if (!moduleId || !lessonId) throw new Error('Missing required fields');
        return LocalDB.saveProgress(userId, moduleId, lessonId, score, maxScore);
      }

      // ── Stats ──
      case 'getUserStats': {
        const userId = p.id;
        const user = LocalDB.getUserById(userId);
        if (!user) throw new Error('User not found');

        const streak = LocalDB.getStreak(userId);
        const completedLessons = LocalDB.completedCount(userId);
        const totalAttempts = LocalDB.totalAttempts(userId);
        const vocabMastered = LocalDB.vocabMasteredCount(userId);
        const vocabTotal = LocalDB.vocabTotalCount(userId);
        const recentActivity = LocalDB.recentActivity(userId);

        const totalLessons = Object.values(courses).reduce((sum, c) =>
          sum + c.modules.reduce((s2, m) => {
            const isLanguage = c.targetLanguage !== c.nativeLanguage;
            return s2 + m.topics.length + (isLanguage ? 1 : 0) + 1;
          }, 0), 0
        );

        return {
          user, streak, totalLessons, completedLessons,
          totalAttempts, vocabMastered, vocabTotal, recentActivity
        };
      }

      // ── Vocabulary ──
      case 'saveVocabulary': {
        const userId = LocalDB.getCurrentUserId();
        if (!userId) throw new Error('Authentication required');
        const { word, translation, moduleId, correct } = body;
        if (!word) throw new Error('Missing fields');
        LocalDB.upsertVocab(userId, word, translation, moduleId, correct);
        return { success: true };
      }

      case 'getUserVocabulary':
        return LocalDB.getVocabulary(p.id);

      // ── LLM Config ──
      case 'getLlmProviders': {
        return Object.entries(LocalLLM.PROVIDERS).map(([key, p]) => ({
          id: key,
          label: p.label,
          apiType: p.apiType,
          defaultUrl: p.url,
          models: p.models,
          requiresApiKey: key !== 'ollama' && key !== 'lmstudio',
          urlPlaceholder: p.urlPlaceholder || p.url || '',
        }));
      }

      case 'getLlmConfig': {
        const cfg = LocalDB.getLlmConfig();
        if (!cfg) {
          return { provider: '', llmUrl: '', llmModel: '', usingDefault: true };
        }
        return {
          provider: cfg.provider || '',
          llmUrl: cfg.llm_url || '',
          llmModel: cfg.llm_model || '',
          usingDefault: false,
        };
      }

      case 'saveLlmConfig': {
        const { provider, llmUrl, llmModel } = body;
        if (!provider) throw new Error('Provider is required');
        if (!LocalLLM.PROVIDERS[provider]) throw new Error('Unknown provider');

        const row = LocalDB.saveLlmConfig({ provider, llmUrl: llmUrl || '', llmModel: llmModel || '' });
        return {
          provider: row.provider,
          llmUrl: row.llm_url,
          llmModel: row.llm_model,
          usingDefault: false,
        };
      }

      case 'deleteLlmConfig':
        LocalDB.deleteLlmConfig();
        return { success: true, usingDefault: true };

      case 'testLlmConfig': {
        const { provider, llmUrl, llmModel } = body;
        const llmApiKey = (options.headers && options.headers['X-LLM-Key']) || undefined;
        if (!provider) throw new Error('Provider is required');
        return await LocalLLM.ping({ provider, llmUrl, llmModel, llmApiKey });
      }

      // ── Profiles (under accounts) ──
      case 'getProfiles':
        return LocalDB.getUsers().map(u => {
          const streak = LocalDB.getStreak(u.id);
          const completedLessons = LocalDB.completedCount(u.id);
          return {
            ...serializeUser(u),
            totalStars: streak.total_stars || 0,
            currentStreak: streak.current_streak || 0,
            completedLessons,
          };
        });

      case 'createProfile': {
        const { name, avatar, pin } = body;
        if (!name || !name.trim()) throw new Error('Name is required');
        const user = LocalDB.createUser(name.trim(), avatar || '🧒', pin || null);
        return serializeUser(user);
      }

      case 'deleteProfile': {
        LocalDB.deleteUser(p.profileId);
        return { success: true };
      }

      default:
        throw new Error(`Unhandled route: ${route.handler}`);
    }
  }

  return { handle };
})();
