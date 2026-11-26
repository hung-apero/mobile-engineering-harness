const PO_ANSWER = /^- \*\*PO (trả lời|chọn)/m;
const AGENT_ANSWER = /^- \*\*Agent tự chốt \(([^)\n]*)\)\s*:?\s*([^*\n]*?)\s*:?\*\*\s*—\s*nguồn:\s*(.*)$/m;

function agentAnswers(text) {
  return (text || '').replace(/\r/g, '').split(/^(?=## Q\d+\b)/m).filter(block => /^## Q\d+\b/.test(block) && !PO_ANSWER.test(block)).map(block => {
    const answer = block.match(AGENT_ANSWER);
    if (!answer) return null;
    return {
      id: block.match(/^## (Q\d+)/)[1],
      title: block.split('\n')[0].replace(/^##\s*/, '').trim(),
      date: answer[1].trim(),
      label: answer[2].trim(),
      source: answer[3].trim().replace(/^"(.*)"$/, '$1'),
    };
  }).filter(Boolean);
}

function unlabelledAgentAnswers(questionsText, specText) {
  const lines = (specText || '').split('\n').filter(line => line.includes('Agent tự chốt'));
  return agentAnswers(questionsText).map(a => a.id).filter(id => !lines.some(line => new RegExp(`\\b${id}\\b`).test(line)));
}

module.exports = { AGENT_ANSWER, agentAnswers, unlabelledAgentAnswers };
