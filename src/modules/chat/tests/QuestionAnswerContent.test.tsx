import assert from 'node:assert/strict';

import { test } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { QuestionAnswerContent } from '@/modules/chat/tools/ContentRenderers/QuestionAnswerContent';

// Regression coverage for the chat-interface crash where an AskUserQuestion
// payload loaded from a session transcript arrives with a non-array `questions`
// or a question missing its `options` array. Rendering must degrade gracefully
// instead of throwing "TypeError: e.map is not a function".

test('renders without throwing when questions is a non-array value', () => {
  assert.doesNotThrow(() => {
    renderToStaticMarkup(
      React.createElement(QuestionAnswerContent, {
        // Malformed: object instead of an array
        questions: { 0: { question: 'q?', options: [{ label: 'a' }] } } as never,
        answers: {},
        isSettled: true,
      }),
    );
  });
});

test('renders without throwing when a question is missing options[]', () => {
  assert.doesNotThrow(() => {
    renderToStaticMarkup(
      React.createElement(QuestionAnswerContent, {
        questions: [{ question: 'Pick one?', header: 'H' } as never],
        answers: { 'Pick one?': 'X' },
        isSettled: true,
      }),
    );
  });
});

test('renders without throwing when options[] contains malformed entries', () => {
  assert.doesNotThrow(() => {
    renderToStaticMarkup(
      React.createElement(QuestionAnswerContent, {
        questions: [{ question: 'Pick one?', options: [null, 'oops', { label: 'A' }] } as never],
        answers: { 'Pick one?': 'A, Custom' },
        isSettled: true,
      }),
    );
  });
});

test('renders without throwing when a questions entry is null/non-object', () => {
  assert.doesNotThrow(() => {
    renderToStaticMarkup(
      React.createElement(QuestionAnswerContent, {
        questions: [null, 'oops', { question: 'Ok?', options: [{ label: 'A' }] }] as never,
        answers: {},
        isSettled: true,
      }),
    );
  });
});

test('renders without throwing when an answer is a non-string value', () => {
  assert.doesNotThrow(() => {
    renderToStaticMarkup(
      React.createElement(QuestionAnswerContent, {
        questions: [{ question: 'Pick one?', options: [{ label: 'A' }] }],
        // Malformed: answer is an object instead of the expected string
        answers: { 'Pick one?': { unexpected: true } } as never,
        isSettled: true,
      }),
    );
  });
});

test('still renders a well-formed question + answer', () => {
  const html = renderToStaticMarkup(
    React.createElement(QuestionAnswerContent, {
      questions: [{ question: 'Pick one?', header: 'H', options: [{ label: 'A' }, { label: 'B' }] }],
      answers: { 'Pick one?': 'A' },
      isSettled: true,
    }),
  );
  assert.ok(html.includes('Pick one?'));
});

test('an option label containing ", " is kept as one answer', () => {
  const html = renderToStaticMarkup(
    React.createElement(QuestionAnswerContent, {
      questions: [{ question: 'Pick one?', options: [{ label: 'Yes, always' }, { label: 'No' }] }],
      answers: { 'Pick one?': 'Yes, always' },
      isSettled: true,
    }),
  );
  // Split on ", " would render "Yes" and "always" as two chips, both unmatched
  // by an option and therefore both labelled custom.
  assert.ok(html.includes('Yes, always'));
  assert.ok(!html.includes('(custom)'));
});

test('a multi-select answer with no exact option still splits on ", "', () => {
  const html = renderToStaticMarkup(
    React.createElement(QuestionAnswerContent, {
      questions: [{ question: 'Pick some?', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }],
      answers: { 'Pick some?': 'A, B' },
      isSettled: true,
    }),
  );
  // Both halves must match an option, so neither is labelled custom and the
  // joined string never survives as a single chip.
  assert.ok(html.includes('>A</span>'));
  assert.ok(html.includes('>B</span>'));
  assert.ok(!html.includes('A, B'));
  assert.ok(!html.includes('(custom)'));
});

test('a question still awaiting its answer is not shown as skipped', () => {
  const props = { questions: [{ question: 'Pick one?', options: [{ label: 'A' }, { label: 'B' }] }], answers: {} };
  const pending = renderToStaticMarkup(React.createElement(QuestionAnswerContent, { ...props, isSettled: false }));
  const declined = renderToStaticMarkup(React.createElement(QuestionAnswerContent, { ...props, isSettled: true }));
  assert.ok(!pending.includes('Skipped'));
  assert.ok(declined.includes('Skipped'));
});
