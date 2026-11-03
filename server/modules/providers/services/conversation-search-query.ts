export type SearchSnippetHighlight = {
  start: number;
  end: number;
};

/**
 * One thing every matching session must contain: a word (matched from the
 * start of a word, so its other grammatical forms match too) or a quoted
 * phrase (matched as written, with any whitespace between its words).
 */
type SearchTerm = {
  /** Lowercased strings that a file must contain for the term to be possible. */
  prefilterStrings: string[];
  pattern: RegExp;
  highlightPattern: RegExp;
};

export type ConversationSearchQuery = {
  terms: SearchTerm[];
  prefilterStrings: string[];
};

export type MessageTermMatch = {
  matchedTermIndexes: number[];
  firstMatchIndex: number;
};

const MIN_STEM_LENGTH = 4;

// Longest first, so "ами" is stripped before "и".
const RUSSIAN_INFLECTION_ENDINGS = [
  'иями', 'ями', 'ами', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'иях', 'ией',
  'ах', 'ях', 'ов', 'ев', 'ей', 'ой', 'ый', 'ий', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие',
  'ую', 'юю', 'ом', 'ем', 'ам', 'ям', 'их', 'ых',
  'а', 'я', 'о', 'е', 'ы', 'и', 'у', 'ю', 'ь', 'й',
];

const CYRILLIC_WORD = /^\p{Script=Cyrillic}+$/u;
const LATIN_WORD = /^\p{Script=Latin}+$/u;
const WORD_CHARACTER = '[\\p{L}\\p{N}_]';
const NOT_PRECEDED_BY_WORD_CHARACTER = `(?<!${WORD_CHARACTER})`;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Cuts a word down to the part its inflected forms share, so a query for
 * "страницы" finds "страниц" and "pages" finds "page". A rough suffix strip
 * rather than a real stemmer: matching then works from the start of a word,
 * which already covers forms that only add letters ("плагин" → "плагина").
 */
export function stemSearchWord(word: string): string {
  const lowered = word.toLowerCase();

  if (CYRILLIC_WORD.test(lowered)) {
    for (const ending of RUSSIAN_INFLECTION_ENDINGS) {
      if (lowered.endsWith(ending) && lowered.length - ending.length >= MIN_STEM_LENGTH) {
        return lowered.slice(0, -ending.length);
      }
    }
    return lowered;
  }

  if (LATIN_WORD.test(lowered) && lowered.length > MIN_STEM_LENGTH && lowered.endsWith('s') && !lowered.endsWith('ss')) {
    return lowered.slice(0, -1);
  }

  return lowered;
}

function createWordTerm(word: string): SearchTerm {
  const stem = stemSearchWord(word);
  const escapedStem = escapeRegex(stem);
  return {
    prefilterStrings: [stem],
    pattern: new RegExp(`${NOT_PRECEDED_BY_WORD_CHARACTER}${escapedStem}`, 'iu'),
    highlightPattern: new RegExp(`${NOT_PRECEDED_BY_WORD_CHARACTER}${escapedStem}${WORD_CHARACTER}*`, 'giu'),
  };
}

function createPhraseTerm(phraseWords: string[]): SearchTerm {
  const phrasePattern = phraseWords.map(escapeRegex).join('\\s+');
  return {
    prefilterStrings: phraseWords.map((word) => word.toLowerCase()),
    pattern: new RegExp(phrasePattern, 'iu'),
    highlightPattern: new RegExp(phrasePattern, 'giu'),
  };
}

/**
 * Splits a search box value into terms. Words are independent: a session
 * matches when it contains every one of them, in any message and any order.
 * Text in double quotes is one exact phrase.
 */
export function parseConversationSearchQuery(rawQuery: string): ConversationSearchQuery {
  const terms: SearchTerm[] = [];
  const quotedPhrase = /"([^"]*)"/g;
  let unquotedText = '';
  let lastIndex = 0;

  for (let match = quotedPhrase.exec(rawQuery); match; match = quotedPhrase.exec(rawQuery)) {
    unquotedText += ` ${rawQuery.slice(lastIndex, match.index)}`;
    lastIndex = match.index + match[0].length;
    const phraseWords = match[1].trim().split(/\s+/).filter(Boolean);
    if (phraseWords.length === 1) {
      unquotedText += ` ${phraseWords[0]}`;
    } else if (phraseWords.length > 1) {
      terms.push(createPhraseTerm(phraseWords));
    }
  }
  unquotedText += ` ${rawQuery.slice(lastIndex)}`;

  const seenWords = new Set<string>();
  for (const word of unquotedText.replace(/"/g, ' ').split(/\s+/)) {
    const lowered = word.toLowerCase();
    if (!lowered || seenWords.has(lowered)) {
      continue;
    }
    seenWords.add(lowered);
    terms.push(createWordTerm(word));
  }

  return {
    terms,
    prefilterStrings: [...new Set(terms.flatMap((term) => term.prefilterStrings))],
  };
}

export function matchQueryTerms(query: ConversationSearchQuery, text: string): MessageTermMatch {
  const matchedTermIndexes: number[] = [];
  let firstMatchIndex = -1;

  query.terms.forEach((term, termIndex) => {
    const match = term.pattern.exec(text);
    if (!match) {
      return;
    }
    matchedTermIndexes.push(termIndex);
    if (firstMatchIndex === -1 || match.index < firstMatchIndex) {
      firstMatchIndex = match.index;
    }
  });

  return { matchedTermIndexes, firstMatchIndex };
}

export function buildQuerySnippet(
  query: ConversationSearchQuery,
  text: string,
  firstMatchIndex: number,
  snippetLength = 150,
): { snippet: string; highlights: SearchSnippetHighlight[] } {
  const anchorIndex = Math.max(0, firstMatchIndex);
  const halfLength = Math.floor(snippetLength / 2);
  const start = Math.max(0, anchorIndex - halfLength);
  const end = Math.min(text.length, anchorIndex + halfLength);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';
  const snippet = `${prefix}${text.slice(start, end).replace(/\n/g, ' ')}${suffix}`;

  const highlights: SearchSnippetHighlight[] = [];
  for (const term of query.terms) {
    term.highlightPattern.lastIndex = 0;
    for (let match = term.highlightPattern.exec(snippet); match; match = term.highlightPattern.exec(snippet)) {
      if (match[0].length === 0) {
        term.highlightPattern.lastIndex += 1;
        continue;
      }
      highlights.push({ start: match.index, end: match.index + match[0].length });
    }
  }

  highlights.sort((left, right) => left.start - right.start);
  const merged: SearchSnippetHighlight[] = [];
  for (const highlight of highlights) {
    const previous = merged[merged.length - 1];
    if (previous && highlight.start <= previous.end) {
      previous.end = Math.max(previous.end, highlight.end);
    } else {
      merged.push({ ...highlight });
    }
  }

  return { snippet, highlights: merged };
}
