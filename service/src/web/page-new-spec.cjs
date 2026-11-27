const { esc, page } = require('./html.cjs');
const { list } = require('./quiz-model.cjs');

function newSpecPage(overview) {
  const options = list(overview?.projects).map(item => `<option value="${esc(item.key)}">${esc(item.key)}</option>`).join('');
  const body = `<main id="main" class="narrow">
<p class="crumb"><a href="/">← Board</a></p>
<h1>Gửi spec mới</h1>
<p class="lead">Hệ thống sẽ đọc spec, soạn câu hỏi cho PO rồi viết lại thành bản rõ ràng để duyệt.</p>
<form id="spec" class="panel stack" novalidate>
<div class="field"><label for="project">Dự án</label><select id="project" name="project" required>${options}</select></div>
<div class="field"><label for="source">Spec</label><textarea id="source" name="source" rows="5" required aria-describedby="source-help"></textarea><p class="help" id="source-help">Dán link Confluence, mã trang, hoặc dán thẳng nội dung spec.</p></div>
<div class="field"><label for="figma">Link Figma <span class="optional">(nếu có)</span></label><input id="figma" name="figma" type="url" inputmode="url" autocomplete="off"></div>
<div class="field"><label for="title">Tên spec <span class="optional">(nếu có)</span></label><input id="title" name="title" maxlength="200" autocomplete="off"></div>
<button class="button" type="submit">Gửi spec</button>
<p class="status" id="status" role="status"></p>
</form>
</main>`;
  return page({ title: 'Gửi spec mới', script: 'new-spec', body });
}

module.exports = { newSpecPage };
