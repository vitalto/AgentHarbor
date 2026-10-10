/**
 * Reads the answers out of an AskUserQuestion tool result, keyed by question
 * text. Shared because both sides fold them into the question card: the server
 * when it loads a transcript, the client when the result streams in live —
 * without the client fold the card read "Skipped" until the page was reloaded.
 */

type AnswerRecord = Record<string, unknown>;

export type AskUserQuestionResult = {
  content?: unknown;
  toolUseResult?: unknown;
};

function readRecord(value: unknown): AnswerRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AnswerRecord : null;
}

function readNonEmptyString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : '';
}

function readJsonRecord(value: string): AnswerRecord | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) {
    return null;
  }
  try {
    return readRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/**
 * Flattens one answer value into the comma-joined label list the question view
 * renders. Claude stores the labels already joined; a `{ answers: [...] }`
 * record and a multi-select array are accepted as well.
 */
function readAnswerLabels(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string').join(', ');
  }

  const record = readRecord(value);
  return record ? readAnswerLabels(record.answers) : '';
}

/**
 * Recovers the answers from Claude's acknowledgement sentence, for a result
 * that arrives without the structured `toolUseResult` — `Your questions have
 * been answered: "<question>"="<answer>".`
 */
function readAnswersFromAcknowledgement(content: string): AnswerRecord {
  if (!content.includes('questions have been answered')) {
    return {};
  }

  const answers: AnswerRecord = {};
  const pattern = /"([^"]+)"\s*=\s*"([^"]*)"/g;
  let match = pattern.exec(content);
  while (match) {
    answers[match[1]] = match[2];
    match = pattern.exec(content);
  }

  return answers;
}

function readRawAnswers(result: AskUserQuestionResult): AnswerRecord | null {
  const structured = readRecord(readRecord(result.toolUseResult)?.answers);
  if (structured) {
    return structured;
  }

  const content = readNonEmptyString(result.content);
  if (!content) {
    return null;
  }

  const fromPayload = readRecord(readJsonRecord(content)?.answers);
  if (fromPayload) {
    return fromPayload;
  }

  const fromSentence = readAnswersFromAcknowledgement(content);
  return Object.keys(fromSentence).length > 0 ? fromSentence : null;
}

/**
 * Answers may be keyed by the question's `id`; Claude keys them by the question
 * text. Settling on the text means the renderer needs no provider knowledge to
 * pair a question with its answer.
 */
function keyAnswersByQuestion(questions: unknown, rawAnswers: AnswerRecord): Record<string, string> {
  const questionById = new Map<string, string>();
  if (Array.isArray(questions)) {
    for (const entry of questions) {
      const question = readRecord(entry);
      const id = readNonEmptyString(question?.id);
      const text = readNonEmptyString(question?.question);
      if (id && text) {
        questionById.set(id, text);
      }
    }
  }

  const answers: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawAnswers)) {
    const labels = readAnswerLabels(value);
    if (labels) {
      answers[questionById.get(key) ?? key] = labels;
    }
  }

  return answers;
}

/** `null` when the result carries no answers in any shape Claude writes. */
export function readAskUserQuestionAnswers(
  questions: unknown,
  result: AskUserQuestionResult | null | undefined,
): Record<string, string> | null {
  if (!result) {
    return null;
  }
  const rawAnswers = readRawAnswers(result);
  return rawAnswers ? keyAnswersByQuestion(questions, rawAnswers) : null;
}
