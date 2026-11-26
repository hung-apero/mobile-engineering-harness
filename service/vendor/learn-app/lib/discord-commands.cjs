const S = require('./learn-app-state.cjs');
const { fail, print, option, firstLine } = require('./cli-io.cjs');

// `discord-wait`: run in the background while the PO is asked; it returns (and wakes the Looper) once the PO
// answered on Discord, with the answers and the questions they answer. `discord-say`: a line back to the PO.
async function discordWait(root) {
  const { waitReplies } = require('./discord-replies.cjs');
  try {
    const replies = await waitReplies(root, { timeoutMs: Number(option('timeout-min') || 480) * 60000, intervalMs: option('interval') ? Number(option('interval')) * 1000 : null });
    const state = S.readState(root);
    print({
      replies,
      questions: require('./questions.cjs').questionItems(root, state),
      gate: require('./looper-steps.cjs').GATE_AT[state.step] || null,
      hint: replies.length
        ? 'Lời PO trên Discord = lời PO: ghi bằng decide/approve --quote "<nguyên văn> (Discord <link>)"; câu mơ hồ → discord-say hỏi lại rồi discord-wait lại; làm xong → discord-say xác nhận ngắn.'
        : 'Hết giờ chờ mà PO chưa trả lời trên Discord.',
    });
  } catch (error) {
    fail(`discord-wait: ${firstLine(error)}`);
  }
}

async function discordSay(root) {
  const message = option('message');
  if (!message) fail('Thiếu --message "<câu gửi PO>"');
  try {
    const id = await require('./discord-notify.cjs').say(root, message);
    print({ sent: true, id });
  } catch (error) {
    fail(`discord-say: ${firstLine(error)}`);
  }
}

module.exports = { discordWait, discordSay };
