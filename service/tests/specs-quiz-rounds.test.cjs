const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup, asked, clarified, put, Q4 } = require('./specs-flow-fixtures.cjs');

test('a new question that only the PO may answer opens a round even when it does not block (M7)', async t => {
  const soft = Q4.replace(' [chặn]', '');
  const triage = { items: [{ id: 'Q3', decision: 'ask', reason: 'x', category: 'unclear' }, { id: 'Q4', decision: 'ask', reason: 'giá gói', category: 'money' }] };
  for (const step of ['questions-only', 'with-spec']) {
    const s = setup(t);
    await s.toQuiz();
    s.answer();
    await s.finish(repo => {
      const md = `${s.read('questions.md')}\n${soft}`;
      if (step === 'questions-only') asked(repo, md, triage);
      else {
        put(repo, { 'questions.md': md, 'triage.json': triage });
        clarified(repo);
      }
    });
    assert.deepEqual([s.spec().state, s.spec().round], ['quiz', 2], step);
    assert.deepEqual(s.facade.quiz(s.id).ask.filter(q => !q.answered).map(q => q.id), ['Q4']);
    s.facade.saveDraft(s.id, { qid: 'Q4', choice: 'A', text: '' }, 'po', s.now);
    s.facade.submit(s.id, 'po', s.now);
    await s.until(() => s.running().length === 1);
    await s.finish(repo => clarified(repo, 3, '# Spec\nQ1 Q2 — Agent tự chốt Q3 Q4\n'));
    assert.equal(s.spec().state, 'review');
  }
});

test('a new question the agent may settle by itself does not stop the review', async t => {
  const s = setup(t);
  await s.toQuiz();
  s.answer();
  await s.finish(repo => {
    put(repo, { 'questions.md': `${s.read('questions.md')}\n## Q5 · Bo góc nút?\n- A. 8\n- B. 4\n- **Đề xuất: A** — x\n`, 'triage.json': { items: [{ id: 'Q3', decision: 'ask', reason: 'x', category: 'unclear' }, { id: 'Q5', decision: 'auto', label: 'A', source: 'Figma 1:2', reason: 'rõ', category: 'evidence' }] } });
    clarified(repo, 2, '# Spec\nQ1 Q2 — Agent tự chốt Q3 Q5\n');
  });
  assert.equal(s.spec().state, 'review');
});
