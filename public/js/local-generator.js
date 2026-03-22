// ─── Local Content Generator ──────────────────────────────────
// Browser-side port of server generator.js.
// Uses LocalLLM and LocalDB for LLM calls and content caching.

const LocalGenerator = (() => {
  const SYSTEM_PROMPT = `You are an expert educational content creator for children and beginners.
You create engaging, age-appropriate learning materials.
You ALWAYS respond with valid JSON only – no markdown, no commentary.
Use plenty of emojis to make content fun and visual.

CRITICAL TRANSLATION RULES:
- When translating to Portuguese, ALWAYS use European Portuguese (PT-PT), NOT Brazilian Portuguese.
- Use natural, everyday translations that a Portuguese child would use.
- NEVER translate literally word-by-word. Use the actual Portuguese word.
- Examples of CORRECT translations: fridge = frigorífico, bathroom = casa de banho, bus = autocarro, mobile phone = telemóvel, computer = computador, ice cream = gelado, train = comboio
- Examples of WRONG translations to AVOID: fridge ≠ armazém gelado, bathroom ≠ sala de banho, bus ≠ ônibus, mobile ≠ celular
- If unsure about a translation, use the most common everyday Portuguese (PT-PT) word.`;

  function _getLlmOverrides() {
    const cfg = LocalDB.getLlmConfig();
    if (!cfg || !cfg.provider) return undefined;
    // The decrypted API key lives in App._llmApiKey (in-memory only, never persisted).
    // We access it directly here since all modules share the same global scope.
    const llmApiKey = (typeof App !== 'undefined' && App._llmApiKey) ? App._llmApiKey : undefined;
    return {
      provider: cfg.provider,
      llmUrl:   cfg.llm_url   || undefined,
      llmModel: cfg.llm_model || undefined,
      llmApiKey,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // Generate a vocabulary/flashcard lesson
  // ═══════════════════════════════════════════════════════════════
  async function generateVocabulary(course, module, topicIndex) {
    const topic = module.topics[topicIndex];
    const cacheKey = `vocab:${course.id}:${module.id}:${topicIndex}`;

    const cached = LocalDB.getContent(cacheKey);
    if (cached) return cached;

    const prompt = _buildVocabPrompt(course, module, topic);
    const content = await LocalLLM.chatJSON([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: prompt }
    ], { overrides: _getLlmOverrides() });

    if (!content.words || !Array.isArray(content.words) || content.words.length === 0) {
      throw new Error('LLM returned invalid vocabulary structure');
    }

    const lesson = {
      id: `${module.id}-vocab-${topicIndex}`,
      title: topic,
      titlePt: content.titlePt || topic,
      type: 'vocabulary',
      topic,
      words: content.words.map(w => ({
        en:        w.en        || w.word     || '',
        pt:        w.pt        || w.translation || '',
        phonetic:  w.phonetic  || '',
        example:   w.example   || '',
        examplePt: w.examplePt || w.example_pt || '',
        emoji:     w.emoji     || '📝',
      })),
    };

    LocalDB.saveContent(cacheKey, lesson);
    return lesson;
  }

  // ═══════════════════════════════════════════════════════════════
  // Generate a quiz
  // ═══════════════════════════════════════════════════════════════
  async function generateQuiz(course, module, variant) {
    const cacheKey = `quiz:${course.id}:${module.id}:${variant}`;

    const cached = LocalDB.getContent(cacheKey);
    if (cached) return cached;

    const prompt = _buildQuizPrompt(course, module, variant);
    const content = await LocalLLM.chatJSON([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: prompt }
    ], { overrides: _getLlmOverrides() });

    if (!content.questions || !Array.isArray(content.questions) || content.questions.length === 0) {
      throw new Error('LLM returned invalid quiz structure');
    }

    const lesson = {
      id: `${module.id}-quiz-${variant}`,
      title: `${module.title} Quiz${variant > 0 ? ` #${variant + 1}` : ''}`,
      titlePt: content.titlePt || `Quiz de ${module.titlePt}`,
      type: 'quiz',
      variant,
      questions: content.questions.map(q => ({
        question:   q.question   || '',
        questionPt: q.questionPt || q.question_pt || '',
        answer:     q.answer     || q.correct     || '',
        options:    q.options    || [],
        emoji:      q.emoji      || '',
        explanation:   q.explanation   || '',
        explanationPt: q.explanationPt || q.explanation_pt || '',
      })),
    };

    LocalDB.saveContent(cacheKey, lesson);
    return lesson;
  }

  // ═══════════════════════════════════════════════════════════════
  // Generate a speaking exercise
  // ═══════════════════════════════════════════════════════════════
  async function generateSpeaking(course, module, variant) {
    const cacheKey = `speak:${course.id}:${module.id}:${variant}`;

    const cached = LocalDB.getContent(cacheKey);
    if (cached) return cached;

    const prompt = _buildSpeakingPrompt(course, module, variant);
    const content = await LocalLLM.chatJSON([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: prompt }
    ], { overrides: _getLlmOverrides() });

    if (!content.exercises || !Array.isArray(content.exercises) || content.exercises.length === 0) {
      throw new Error('LLM returned invalid speaking structure');
    }

    const lesson = {
      id: `${module.id}-speak-${variant}`,
      title: `${module.title} – Speaking`,
      titlePt: content.titlePt || `Falar – ${module.titlePt}`,
      type: 'speaking',
      variant,
      exercises: content.exercises.map(ex => ({
        phrase:      ex.phrase      || ex.word || '',
        phrasePt:    ex.phrasePt    || ex.translation || '',
        phonetic:    ex.phonetic    || '',
        hint:        ex.hint        || '',
        hintPt:      ex.hintPt      || '',
        difficulty:  ex.difficulty   || 'easy',
        emoji:       ex.emoji       || '🗣️',
        acceptAlso:  ex.acceptAlso  || [],
      })),
    };

    LocalDB.saveContent(cacheKey, lesson);
    return lesson;
  }

  // ═══════════════════════════════════════════════════════════════
  // Get lesson list for a module
  // ═══════════════════════════════════════════════════════════════
  function getLessonList(course, module) {
    const lessons = [];
    const isLanguage = course.targetLanguage !== course.nativeLanguage;

    module.topics.forEach((topic, i) => {
      const cacheKey = `vocab:${course.id}:${module.id}:${i}`;
      const cached = LocalDB.getContent(cacheKey);
      lessons.push({
        id: `${module.id}-vocab-${i}`,
        title: topic,
        titlePt: cached?.titlePt || topic,
        type: 'vocabulary',
        topicIndex: i,
        generated: !!cached,
      });
    });

    if (isLanguage) {
      const speakCacheKey = `speak:${course.id}:${module.id}:0`;
      const speakCached = LocalDB.getContent(speakCacheKey);
      lessons.push({
        id: `${module.id}-speak-0`,
        title: `${module.title} – Speaking`,
        titlePt: speakCached?.titlePt || `Falar – ${module.titlePt}`,
        type: 'speaking',
        variant: 0,
        generated: !!speakCached,
      });
    }

    const quizCacheKey = `quiz:${course.id}:${module.id}:0`;
    const quizCached = LocalDB.getContent(quizCacheKey);
    lessons.push({
      id: `${module.id}-quiz-0`,
      title: `${module.title} Quiz`,
      titlePt: quizCached?.titlePt || `Quiz de ${module.titlePt}`,
      type: 'quiz',
      variant: 0,
      generated: !!quizCached,
    });

    return lessons;
  }

  // ═══════════════════════════════════════════════════════════════
  // Get or generate a specific lesson
  // ═══════════════════════════════════════════════════════════════
  async function getLesson(course, module, lessonId) {
    const quizMatch  = lessonId.match(/^(.+)-quiz-(\d+)$/);
    const vocabMatch = lessonId.match(/^(.+)-vocab-(\d+)$/);
    const speakMatch = lessonId.match(/^(.+)-speak-(\d+)$/);

    if (quizMatch)  return generateQuiz(course, module, parseInt(quizMatch[2], 10));
    if (vocabMatch) return generateVocabulary(course, module, parseInt(vocabMatch[2], 10));
    if (speakMatch) return generateSpeaking(course, module, parseInt(speakMatch[2], 10));

    throw new Error(`Unknown lesson format: ${lessonId}`);
  }

  // ═══════════════════════════════════════════════════════════════
  // PROMPT BUILDERS (identical to server)
  // ═══════════════════════════════════════════════════════════════

  function _buildVocabPrompt(course, module, topic) {
    const isLanguage = course.targetLanguage !== course.nativeLanguage;
    const count = '6 to 8';

    if (isLanguage) {
      return `Create a vocabulary flashcard lesson for children learning ${course.targetLanguage}.
Their native language is ${course.nativeLanguage}.
Level: ${course.level}. Age group: ${course.ageGroup}.

Module: "${module.title}"
Topic: "${topic}"
Learning objectives: ${module.objectives.join('; ')}

Generate ${count} vocabulary words/phrases for this specific topic.

Respond with this exact JSON structure:
{
  "titlePt": "Portuguese title for this lesson",
  "words": [
    {
      "en": "English word or phrase",
      "pt": "Portuguese translation",
      "phonetic": "IPA pronunciation like /wɜːrd/",
      "example": "Simple example sentence in ${course.targetLanguage}",
      "examplePt": "Translation of the example in ${course.nativeLanguage}",
      "emoji": "relevant emoji"
    }
  ]
}

Rules:
- Keep examples very simple and age-appropriate
- Use common, everyday words
- Include a relevant emoji for each word
- Phonetic transcription in IPA format
- Words should progressively build on each other
- Make it fun and engaging for children
- ALL Portuguese translations MUST be natural European Portuguese (PT-PT)
- NEVER translate literally – use the real Portuguese word (e.g. "fridge" = "frigorífico", NOT "armazém gelado")
- The "pt" field must contain the word a Portuguese child would actually say in daily life
- The "examplePt" must sound natural in European Portuguese, not a word-by-word translation`;
    }

    return `Create a learning lesson for children about "${topic}".
The lesson language is ${course.nativeLanguage}.
Level: ${course.level}. Age group: ${course.ageGroup}.

Subject: "${module.title}"
Topic: "${topic}"
Learning objectives: ${module.objectives.join('; ')}

Generate ${count} key concepts/items to learn for this specific topic.

Respond with this exact JSON structure:
{
  "titlePt": "Title in ${course.nativeLanguage}",
  "words": [
    {
      "en": "Concept or term",
      "pt": "Explanation or definition in ${course.nativeLanguage}",
      "phonetic": "",
      "example": "Example or visual representation",
      "examplePt": "Explanation of the example in ${course.nativeLanguage}",
      "emoji": "relevant emoji"
    }
  ]
}

Rules:
- Keep everything age-appropriate and fun
- Use visual examples with emojis
- Build concepts progressively
- Make it interactive and engaging`;
  }

  function _buildQuizPrompt(course, module, variant) {
    const isLanguage = course.targetLanguage !== course.nativeLanguage;
    const count = '5 to 7';
    const variety = variant > 0 ? `\nThis is variant #${variant + 1} – create DIFFERENT questions from previous quizzes.` : '';

    if (isLanguage) {
      return `Create a multiple-choice quiz for children learning ${course.targetLanguage}.
Their native language is ${course.nativeLanguage}.
Level: ${course.level}. Age group: ${course.ageGroup}.${variety}

Module: "${module.title}"
Topics covered: ${module.topics.join(', ')}
Learning objectives: ${module.objectives.join('; ')}

Generate ${count} multiple-choice questions.

Respond with this exact JSON structure:
{
  "titlePt": "Quiz title in ${course.nativeLanguage}",
  "questions": [
    {
      "question": "Question in ${course.targetLanguage}",
      "questionPt": "Question translated to ${course.nativeLanguage}",
      "answer": "The correct answer (must be one of the options)",
      "options": ["option1", "option2", "option3", "option4"],
      "emoji": "relevant emoji or empty string",
      "explanation": "Brief explanation in ${course.targetLanguage} of WHY this is the correct answer",
      "explanationPt": "Same explanation in ${course.nativeLanguage}, simple and clear for a child"
    }
  ]
}

Rules:
- Each question must have exactly 4 options
- The answer field must exactly match one of the options
- Mix question types: translation, fill-in, comprehension
- Keep language simple and age-appropriate
- Include emojis where relevant
- Questions should test vocabulary and understanding
- The explanation must be VERY simple, 1-2 sentences max, suitable for a child. Explain WHY the answer is correct and why the wrong choice might be confusing.
- ALL Portuguese text MUST be natural European Portuguese (PT-PT), never Brazilian Portuguese
- Translations must be the real everyday word, NEVER literal translations`;
    }

    return `Create a multiple-choice quiz for children about "${module.title}".
The quiz language is ${course.nativeLanguage}.
Level: ${course.level}. Age group: ${course.ageGroup}.${variety}

Topics covered: ${module.topics.join(', ')}
Learning objectives: ${module.objectives.join('; ')}

Generate ${count} multiple-choice questions.

Respond with this exact JSON structure:
{
  "titlePt": "Quiz title in ${course.nativeLanguage}",
  "questions": [
    {
      "question": "Question text",
      "questionPt": "Same question (already in ${course.nativeLanguage})",
      "answer": "The correct answer (must be one of the options)",
      "options": ["option1", "option2", "option3", "option4"],
      "emoji": "relevant emoji or empty string",
      "explanation": "Brief explanation of WHY this is the correct answer",
      "explanationPt": "Same explanation in ${course.nativeLanguage}, simple and clear for a child"
    }
  ]
}

Rules:
- Each question must have exactly 4 options
- The answer field must exactly match one of the options
- Mix question types: conceptual, visual, practical
- Keep language simple and age-appropriate
- Include emojis where relevant
- The explanation must be VERY simple, 1-2 sentences max, suitable for a child. Explain WHY the answer is correct.`;
  }

  function _buildSpeakingPrompt(course, module, variant) {
    const variety = variant > 0 ? `\nThis is variant #${variant + 1} – create DIFFERENT exercises from previous ones.` : '';

    return `Create a speaking / pronunciation exercise set for children learning ${course.targetLanguage}.
Their native language is ${course.nativeLanguage}.
Level: ${course.level}. Age group: ${course.ageGroup}.${variety}

Module: "${module.title}"
Topics covered: ${module.topics.join(', ')}
Learning objectives: ${module.objectives.join('; ')}

Generate 6 to 8 phrases/words the child should read aloud and pronounce.
Start with easy single words, then progress to short phrases and simple sentences.

Respond with this exact JSON structure:
{
  "titlePt": "Speaking exercise title in ${course.nativeLanguage}",
  "exercises": [
    {
      "phrase": "Word or phrase in ${course.targetLanguage} the child must say",
      "phrasePt": "Translation in ${course.nativeLanguage}",
      "phonetic": "IPA pronunciation like /wɜːrd/",
      "hint": "Pronunciation tip in ${course.targetLanguage}",
      "hintPt": "Pronunciation tip in ${course.nativeLanguage} – simple, for a child",
      "difficulty": "easy|medium|hard",
      "emoji": "relevant emoji",
      "acceptAlso": ["alternative accepted forms – e.g. without article, singular/plural"]
    }
  ]
}

Rules:
- Start with single words (easy), then 2-3 word phrases (medium), then short sentences (hard)
- Use words and phrases from the module topics
- Phonetic must be IPA
- The hint should help a ${course.nativeLanguage}-speaking child pronounce difficult sounds
- acceptAlso contains spelling variations that the speech recogniser might return (e.g. lowercase, without punctuation, number words vs digits)
- Keep everything age-appropriate, fun, and encouraging
- Mix vocabulary from all the module topics
- ALL Portuguese text MUST be natural European Portuguese (PT-PT)
- Translations must use the real everyday Portuguese word, never literal translations`;
  }

  return { generateVocabulary, generateQuiz, generateSpeaking, getLessonList, getLesson };
})();
