import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bankAnswerToCaptions,
  courseScope,
  toBankAnswer,
  toBankQuestion,
} from '../src/bank.ts';

const question = (html, options = []) => ({
  content: { html },
  options: options.map(([caption, text]) => ({ caption, content: { html: text } })),
});

test('single choice maps captions to option ids and keeps option text', () => {
  const mapped = toBankQuestion('singlechoice', question(
    '<p>What did the speaker buy?</p>',
    [['A', '<b>An apple</b>&nbsp;pie'], ['B', 'A pear'], ['C', 'A peach']],
  ));
  assert.deepEqual(mapped, {
    kind: 'single',
    text: 'What did the speaker buy?',
    options: [
      { id: 'A', text: 'An apple pie' },
      { id: 'B', text: 'A pear' },
      { id: 'C', text: 'A peach' },
    ],
    blanks: 0,
  });
  assert.equal(mapped.context, undefined);
  assert.equal(toBankQuestion('choice', question('Q', [['A', 'x']])).kind, 'single');
});

test('multiple choice maps to kind multiple', () => {
  const mapped = toBankQuestion('multichoice', question(
    'Which two are mentioned?',
    [['A', 'rain'], ['B', 'snow'], ['C', 'wind']],
  ));
  assert.equal(mapped.kind, 'multiple');
  assert.deepEqual(mapped.options.map((option) => option.id), ['A', 'B', 'C']);
  assert.deepEqual(mapped.options.map((option) => option.text), ['rain', 'snow', 'wind']);
});

test('true/false maps to judge when wording is explicit', () => {
  const english = toBankQuestion('truefalse', question('The story is true.', [
    ['A', 'True'],
    ['B', 'False'],
  ]));
  assert.equal(english.kind, 'judge');
  assert.deepEqual(english.options.map((option) => option.text), ['True', 'False']);

  const chinese = toBankQuestion('truefalse', question('判断', [
    ['A', '正确'],
    ['B', '错误'],
  ]));
  assert.equal(chinese.kind, 'judge');
  const letters = toBankQuestion('truefalse', question('判断', [
    ['T', 'T'],
    ['F', 'F'],
  ]));
  assert.equal(letters.kind, 'judge');
});

test('fillblank maps to blank with one empty slot and no options', () => {
  for (const category of ['fillblank', 'fillblankScoop', 'fillblankchoice']) {
    const mapped = toBankQuestion(category, question('The capital is ____.'));
    assert.deepEqual(mapped, {
      kind: 'blank',
      text: 'The capital is ____.',
      options: [],
      blanks: 1,
    });
  }
});

test('unsupported categories return null', () => {
  const source = question('Order these.', [['A', 'one'], ['B', 'two']]);
  assert.equal(toBankQuestion('sequence', source), null);
  assert.equal(toBankQuestion('shortanswerscoop', question('Explain.')), null);
  assert.equal(toBankQuestion('discussion', question('Discuss.')), null);
  assert.equal(toBankQuestion('', source), null);
});

test('ambiguous or invalid questions return null', () => {
  assert.equal(toBankQuestion('singlechoice', question('   ', [['A', 'x']])), null);
  assert.equal(toBankQuestion('singlechoice', question('Pick', [])), null);
  assert.equal(toBankQuestion('singlechoice', question('Pick', [['A', 'same'], ['B', 'same']])), null);
  assert.equal(toBankQuestion('singlechoice', question('Pick', [['A', 'one'], ['A', 'two']])), null);
  assert.equal(toBankQuestion('singlechoice', question('Pick', [['A', 'one'], ['B', '']])), null);
  assert.equal(toBankQuestion('truefalse', question('True or false?', [
    ['A', 'True'],
    ['B', 'Not given'],
  ])), null);
  assert.equal(toBankQuestion('truefalse', question('True or false?', [
    ['A', 'True'],
    ['B', 'True'],
  ])), null);
  assert.equal(toBankQuestion('truefalse', question('True or false?', [
    ['A', 'True'],
    ['B', 'False'],
    ['C', 'Not given'],
  ])), null);
});

test('fillblank with more than one slot marker is skipped', () => {
  assert.equal(toBankQuestion('fillblank', question('A ____ and B ____.')), null);
  assert.equal(toBankQuestion('fillblank', question('A ____1____ and B ____2____.')), null);
  assert.equal(toBankQuestion('fillblank', question('A {{1}} and B {{2}}')), null);
  assert.notEqual(toBankQuestion('fillblank', question('A ____ and B.')), null);
});

test('judge round trip: caption -> true/false -> caption', () => {
  const mapped = toBankQuestion('truefalse', question('The statement is correct.', [
    ['A', 'True'],
    ['B', 'False'],
  ]));
  assert.deepEqual(bankAnswerToCaptions(mapped, ['true']), ['A']);
  assert.deepEqual(bankAnswerToCaptions(mapped, ['false']), ['B']);
  assert.deepEqual(toBankAnswer(mapped, ['A']), ['true']);
  assert.deepEqual(toBankAnswer(mapped, ['B']), ['false']);
  assert.deepEqual(toBankAnswer(mapped, ['true']), ['true']);
  assert.equal(toBankAnswer(mapped, ['C']), null);
});

test('bank answer objects map back to current option ids', () => {
  const single = toBankQuestion('singlechoice', question('Pick one', [
    ['A', 'Alpha'],
    ['B', 'Beta'],
  ]));
  assert.deepEqual(bankAnswerToCaptions(single, ['A']), ['A']);
  assert.deepEqual(bankAnswerToCaptions(single, ['Beta']), ['B']);
  assert.equal(bankAnswerToCaptions(single, ['Gamma']), null);
  assert.equal(bankAnswerToCaptions(single, []), null);

  const multiple = toBankQuestion('multichoice', question('Pick two', [
    ['A', 'Alpha'],
    ['B', 'Beta'],
    ['C', 'Gamma'],
  ]));
  assert.deepEqual(bankAnswerToCaptions(multiple, ['A', 'C']), ['A', 'C']);
  assert.deepEqual(bankAnswerToCaptions(multiple, ['Gamma', 'Alpha']), ['C', 'A']);
  assert.equal(bankAnswerToCaptions(multiple, ['A', 'A']), null);
});

test('blank answers pass through as text', () => {
  const blank = toBankQuestion('fillblank', question('Fill ____ here.'));
  assert.deepEqual(bankAnswerToCaptions(blank, ['  climate change  ']), ['climate change']);
  assert.deepEqual(toBankAnswer(blank, ['climate change']), ['climate change']);
  assert.equal(toBankAnswer(blank, ['   ']), null);
});

test('course scope requires content and class ids', () => {
  assert.equal(courseScope({ content_id: '123', class_id: '456' }), '123:456');
  assert.equal(courseScope({ content_id: '123' }), null);
  assert.equal(courseScope({ content_id: '', class_id: '456' }), null);
  assert.equal(courseScope(null), null);
});
