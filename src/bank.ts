// Question bank bridge for U校园 classic.
//
// The host owns storage and matching; this module only maps platform questions
// to the shared question-bank contract and reuses hosted answers. Every helper
// is deliberately defensive: a bank miss or a malformed question must never
// break the study flow.

export type BankKind = 'single' | 'multiple' | 'judge' | 'blank';

export type BankOption = { id: string; text: string };

export type BankQuestion = {
  kind: BankKind;
  text: string;
  options: BankOption[];
  blanks: number;
};

export type BankEntry = {
  index: number;
  category: string;
  question: any;
};

type BankHost = {
  call(method: string, params: any): Promise<any>;
  log?(level: string, message: string): void;
};

let host: BankHost | null = null;

/** Wired once by module.ts so the pure mappers stay importable in tests. */
export function bindBank(value: BankHost): void {
  host = value;
}

function plain(value: any): string {
  return String(value ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function bankKind(category: any): BankKind | null {
  const value = String(category ?? '').trim().toLowerCase();
  if (value === 'singlechoice' || value === 'choice') return 'single';
  if (value === 'multichoice' || value === 'multi_choice') return 'multiple';
  if (value === 'truefalse' || value === 'true_false') return 'judge';
  if (/^fillblank/.test(value)) return 'blank';
  return null;
}

// Explicit true/false wording only; anything else is skipped instead of guessed.
const TRUE_WORDS = new Set(['true', 't', 'yes', 'y', '正确', '对', '√']);
const FALSE_WORDS = new Set(['false', 'f', 'no', 'n', '错误', '错', '×']);

function judgeValue(value: any): 'true' | 'false' | null {
  const text = plain(value).toLowerCase().replace(/[.。:：!！\s]/g, '');
  if (!text) return null;
  if (TRUE_WORDS.has(text)) return 'true';
  if (FALSE_WORDS.has(text)) return 'false';
  return null;
}

function optionList(question: any): BankOption[] {
  return (Array.isArray(question?.options) ? question.options : []).map((option: any) => ({
    id: String(option?.caption ?? '').trim(),
    text: plain(option?.content?.html),
  }));
}

function hasDuplicate(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

function blankSlots(text: string): number {
  return (text.match(/_{2,}|\{\{\d+\}\}/g) ?? []).length;
}

/**
 * Map one platform question to a bank question, or null when the mapping would
 * be ambiguous (unsupported category, empty text, duplicate options, unclear
 * judge wording, or more than one blank marker on a single-blank question).
 * `context` is intentionally omitted: ASR transcripts and transcriptions must
 * never take part in the fingerprint.
 */
export function toBankQuestion(category: any, question: any): BankQuestion | null {
  const kind = bankKind(category);
  if (!kind) return null;
  const text = plain(question?.content?.html);
  if (!text) return null;

  if (kind === 'blank') {
    if (blankSlots(text) > 1) return null;
    return { kind, text, options: [], blanks: 1 };
  }

  const options = optionList(question);
  if (options.length === 0) return null;
  for (const option of options) {
    if (!option.id || !option.text) return null;
  }
  if (hasDuplicate(options.map((option) => option.id))) return null;
  if (hasDuplicate(options.map((option) => option.text))) return null;

  if (kind === 'judge') {
    if (options.length !== 2) return null;
    const values = options.map((option) => judgeValue(option.text));
    if (values.some((value) => value === null)) return null;
    if (new Set(values).size !== 2) return null;
  }

  return { kind, text, options, blanks: 0 };
}

function matchOption(question: BankQuestion, value: any): BankOption | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const byId = question.options.find((option) => option.id === raw);
  if (byId) return byId;
  const byText = question.options.filter((option) => option.text === raw);
  return byText.length === 1 ? byText[0] : null;
}

/**
 * Bank lookup answers use option text internally, but current option ids are
 * returned. For this module the option id is the platform caption, so a stored
 * answer can be handed back as-is; judge answers (`true`/`false`) map to the
 * caption carrying that wording.
 */
export function bankAnswerToCaptions(
  question: BankQuestion,
  answer: any,
): string[] | null {
  if (!Array.isArray(answer) || answer.length === 0) return null;
  if (question.kind === 'blank') {
    if (answer.length !== 1) return null;
    const values = answer.map((value) => String(value ?? '').trim()).filter(Boolean);
    return values.length ? values : null;
  }
  if (question.kind === 'judge') {
    if (answer.length !== 1) return null;
    const raw = String(answer[0] ?? '').trim().toLowerCase();
    const semantic = raw === 'true' || raw === 'false' ? raw : judgeValue(raw);
    if (!semantic) return null;
    const option = question.options.find((value) => judgeValue(value.text) === semantic);
    return option ? [option.id] : null;
  }
  if (question.kind === 'single' && answer.length !== 1) return null;
  const out: string[] = [];
  for (const value of answer) {
    const option = matchOption(question, value);
    if (!option || out.includes(option.id)) return null;
    out.push(option.id);
  }
  return out.length ? out : null;
}

/** Convert platform captions/blank text into the answer shape the bank stores. */
export function toBankAnswer(
  question: BankQuestion,
  values: string[],
): string[] | null {
  if (question.kind === 'blank') {
    if (values?.length !== 1) return null;
    const text = String(values[0] ?? '').trim();
    return text ? [text] : null;
  }
  if (question.kind === 'judge') {
    if (values?.length !== 1) return null;
    const raw = String(values[0] ?? '').trim().toLowerCase();
    if (raw === 'true' || raw === 'false') return [raw];
    const option = matchOption(question, values[0]);
    const semantic = option ? judgeValue(option.text) : null;
    return semantic ? [semantic] : null;
  }
  if (question.kind === 'single' && values?.length !== 1) return null;
  const out: string[] = [];
  for (const value of values ?? []) {
    const option = matchOption(question, value);
    if (!option || out.includes(option.id)) return null;
    out.push(option.id);
  }
  return out.length ? out : null;
}

/** Stable course scope: content id identifies the course, class id the cohort. */
export function courseScope(course: any): string | null {
  const contentId = String(course?.content_id ?? '').trim();
  const classId = String(course?.class_id ?? '').trim();
  if (!contentId || !classId) return null;
  return `${contentId}:${classId}`;
}

/** Query the host bank for a batch; any failure is logged and skipped. */
export async function lookupAnswers(
  session: string,
  course: string,
  entries: BankEntry[],
): Promise<Record<number, string[]>> {
  const out: Record<number, string[]> = {};
  if (!host || !course || !Array.isArray(entries)) return out;
  for (const entry of entries) {
    const question = toBankQuestion(entry.category, entry.question);
    if (!question) continue;
    try {
      const result = await host.call('cw.question_bank.lookup', {
        session,
        course,
        question,
      });
      const captions = bankAnswerToCaptions(question, result?.correct);
      if (captions) out[entry.index] = captions;
    } catch (error) {
      host.log?.('warn', `question bank lookup skipped: ${errorText(error)}`);
    }
  }
  return out;
}

/** Confirm one platform-verified answer; never throws into the study flow. */
export async function confirmCorrect(
  session: string,
  course: string,
  question: BankQuestion,
  answer: string[],
  reference: string,
): Promise<boolean> {
  if (!host) return false;
  try {
    await host.call('cw.question_bank.confirm', {
      session,
      course,
      question,
      answer,
      confirmation: { confirmed: true, source: 'platform', reference },
    });
    return true;
  } catch (error) {
    host.log?.('warn', `question bank confirm skipped: ${errorText(error)}`);
    return false;
  }
}

/**
 * Confirm a whole group after the platform reports a perfect score. Answers are
 * the values actually submitted (captions for choice, text for blanks).
 */
export async function confirmGroup(
  session: string,
  course: string,
  category: any,
  questions: any[],
  answers: any[],
  reference: string,
): Promise<number> {
  if (!host || !course || !Array.isArray(questions)) return 0;
  let saved = 0;
  for (let index = 0; index < questions.length; index += 1) {
    const question = toBankQuestion(category, questions[index]);
    if (!question) continue;
    const raw = answers?.[index];
    const values = Array.isArray(raw) ? raw.map(String) : [String(raw ?? '')];
    const answer = toBankAnswer(question, values);
    if (!answer) continue;
    if (await confirmCorrect(session, course, question, answer, reference)) saved += 1;
  }
  return saved;
}

function errorText(error: any): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') return String(error.message ?? error.code ?? error);
  return String(error);
}
