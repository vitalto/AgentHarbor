import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildQuerySnippet,
  matchQueryTerms,
  parseConversationSearchQuery,
  stemSearchWord,
} from '@/modules/providers/services/conversation-search-query.js';

const matchesEveryTerm = (rawQuery: string, text: string): boolean => {
  const query = parseConversationSearchQuery(rawQuery);
  return matchQueryTerms(query, text).matchedTermIndexes.length === query.terms.length;
};

test('a word matches its inflected forms from the start of a word', () => {
  assert.equal(stemSearchWord('страницы'), 'страниц');
  assert.equal(stemSearchWord('Плагина'), 'плагин');
  assert.equal(stemSearchWord('pages'), 'page');
  assert.equal(stemSearchWord('class'), 'class');
  assert.equal(stemSearchWord('дом'), 'дом');

  assert.ok(matchesEveryTerm('плагин', 'Сделали плагином вкладку'));
  assert.ok(matchesEveryTerm('страницы', 'показ ZeroTier-страниц'));
  assert.ok(matchesEveryTerm('plugin', 'the plugins folder'));
  assert.ok(matchesEveryTerm('pages', 'plugins/pages/index.js'));
  assert.equal(matchesEveryTerm('плагин', 'суперплагин'), false);
});

test('words of a query match in any order and need not be adjacent', () => {
  assert.ok(matchesEveryTerm('pages плагин', 'плагин для вкладки Pages'));
  assert.equal(matchesEveryTerm('pages плагин', 'только pages'), false);
});

test('a quoted phrase matches only as written', () => {
  assert.ok(matchesEveryTerm('"pages plugin"', 'the Pages  plugin tab'));
  assert.equal(matchesEveryTerm('"pages plugin"', 'plugin for pages'), false);
  assert.ok(matchesEveryTerm('tab "pages plugin"', 'Pages plugin in a tab'));
});

test('a snippet highlights each matched word to its end', () => {
  const query = parseConversationSearchQuery('плагин pages');
  const text = 'Плагины для вкладки Pages готовы';
  const { snippet, highlights } = buildQuerySnippet(query, text, matchQueryTerms(query, text).firstMatchIndex);

  assert.deepEqual(
    highlights.map(({ start, end }) => snippet.slice(start, end)),
    ['Плагины', 'Pages'],
  );
});
