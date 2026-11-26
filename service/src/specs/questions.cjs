const OPTION = /^- ([A-Z])\.\s+(.*)$/;
const PROPOSAL = /\*\*Đề xuất:?\s*([A-Z](?:\|[A-Z])*)?\s*:?\s*\*\*\s*(?:[—–-]\s*)?(.*)$/;
const PO_LINE = /^(?:- )?\*\*PO (?:trả lời|chọn) \(([^)]*)\)\s*:?\s*([^*]*?)\s*:?\*\*\s*(?::\s*)?(.*)$/;
const AGENT_LINE = /^(?:- )?\*\*Agent tự chốt \(([^)]*)\)\s*:?\s*([^*]*?)\s*:?\*\*\s*(.*)$/;
const QUOTED = /"(.*)"\s*$/;

function splitBlocks(md) {
  return String(md ?? '').split(/^(?=## )/m).filter(block => /^## Q\d+\b/.test(block));
}

function quoted(rest) {
  const m = rest.match(QUOTED);
  return m ? m[1] : rest.replace(/^[—–-]\s*/, '').replace(/^[^:]*:\s*/, '').trim();
}

function labelAndText(match) {
  const rest = match[3];
  const bare = !match[2] && rest.match(/^([A-Z])\b/);
  return { label: match[2] || (bare ? bare[1] : undefined), text: quoted(rest) };
}

function parseBlock(block) {
  const lines = block.replace(/\r/g, '').split('\n');
  const head = lines[0].replace(/^##\s*/, '').trim();
  const id = head.match(/^(Q\d+)/)[1];
  const question = {
    id,
    title: head.replace(/^Q\d+\s*[·.:-]?\s*/, '').replace(/\s*\[chặn\]/g, '').trim(),
    body: '',
    blocking: /\[chặn\]/.test(head),
    options: [],
    proposal: null,
    answered: false,
    answer: null,
  };
  const body = [];
  for (const line of lines.slice(1)) {
    const option = line.match(OPTION);
    const proposal = line.match(PROPOSAL);
    const po = line.match(PO_LINE);
    const agent = line.match(AGENT_LINE);
    if (po) question.answer = { kind: 'po', ...labelAndText(po) };
    else if (agent && !question.answer) question.answer = { kind: 'agent', ...labelAndText(agent) };
    else if (proposal) {
      const rest = proposal[2].trim();
      const label = proposal[1] || (/^[A-Z]$/.test(rest.split(/\s/)[0]) ? rest.split(/\s/)[0] : '');
      const reason = proposal[1] ? rest : rest.slice(label.length).replace(/^\s*[—–-]\s*/, '');
      question.proposal = { label, reason };
    } else if (option) question.options.push({ label: option[1], text: option[2].trim() });
    else if (!question.options.length && line.trim()) body.push(line.trim());
  }
  question.body = body.join('\n');
  question.answered = question.answer !== null;
  return question;
}

function parseQuestions(md) {
  return splitBlocks(md).map(parseBlock);
}

module.exports = { parseQuestions, splitBlocks, PO_LINE, AGENT_LINE };
