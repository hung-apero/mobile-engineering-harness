const quiz = require('./api-quiz.cjs');
const review = require('./api-review.cjs');
const spec = require('./api-spec.cjs');
const releaseApi = require('./api-release.cjs');
const newappApi = require('./api-newapp.cjs');
const { homePage } = require('./page-home.cjs');
const { newSpecPage } = require('./page-new-spec.cjs');
const { quizPage } = require('./page-quiz.cjs');
const { reviewPage } = require('./page-review.cjs');
const { releasePage } = require('./page-release.cjs');
const { newAppPage } = require('./page-newapp.cjs');
const { loadRelease } = require('./release-load.cjs');
const { boardListPage, boardProjectPage } = require('./page-board.cjs');
const { boardModel, projectBoard } = require('../board/model.cjs');
const { specDetail } = require('../board/spec-detail.cjs');
const { specDetailPage } = require('./page-spec-detail.cjs');
const { readJobLog } = require('../board/job-log.cjs');
const jobsStore = require('../jobs.cjs');
const { controlJob } = require('../board/job-control.cjs');
const { WebError } = require('./web-error.cjs');

const GET = ['GET', 'HEAD'];
const POST = ['POST'];

const view = (name, auth, path, run, extra = {}) => ({ name, auth, path, run, methods: GET, api: false, ...extra });
const call = (name, auth, path, run, methods = POST) => ({ name, auth, path, run, methods, api: true });
const tokenCall = (kind, action, run, methods) => call(`${kind}-${action}`, kind, new RegExp(`^/api/${kind}/([\\w-]{1,200})/${action}$`), run, methods);

const KEY = '([A-Z][A-Z0-9]{1,19})';
const VERSION = '([0-9][0-9A-Za-z.-]{0,39})';

const ROUTES = [
  view('home', 'operator', /^\/$/, async ({ facade, now }) => homePage(await facade.overview(now), now), { login: true }),
  view('new-spec', 'operator', /^\/spec\/new$/, async ({ facade, now }) => newSpecPage(await facade.overview(now))),
  call('new-spec-save', 'operator', /^\/api\/spec\/new$/, spec.create),
  view('release', 'operator', new RegExp(`^/release/${KEY}/${VERSION}$`), async ({ ctx, params, query, now }) => releasePage(await loadRelease(ctx, params, now, query.get('fresh') === '1'), now)),
  call('release-defer', 'operator', new RegExp(`^/api/release/${KEY}/${VERSION}/defer$`), releaseApi.defer),
  view('new-app', 'operator', /^\/app\/new$/, ({ ctx, query }) => newAppPage(ctx, query.get('key'))),
  call('new-app-save', 'operator', /^\/api\/app\/new$/, newappApi.save),
  call('new-app-check', 'operator', /^\/api\/app\/new\/check$/, newappApi.check),
  view('quiz', 'quiz', /^\/quiz\/([\w-]{1,200})$/, async ({ facade, specId }) => quizPage(await facade.quiz(specId))),
  tokenCall('quiz', 'state', quiz.state, GET),
  tokenCall('quiz', 'draft', quiz.draft),
  tokenCall('quiz', 'submit', quiz.submit),
  tokenCall('quiz', 'ask', quiz.ask),
  tokenCall('quiz', 'auto', quiz.auto),
  view('review', 'review', /^\/review\/([\w-]{1,200})$/, async ({ facade, specId }) => reviewPage(await facade.review(specId))),
  tokenCall('review', 'approve', review.approve),
  tokenCall('review', 'feedback', review.feedback),
  view('board', 'viewer', /^\/board\/([\w-]{1,200})$/, ({ ctx, viewer, token, now }) => boardListPage(boardModel(ctx, viewer, now), token, now)),
  view('board-project', 'viewer', new RegExp(`^/board/([\\w-]{1,200})/${KEY}$`), ({ ctx, viewer, token, params, now }) => {
    const found = projectBoard(ctx, viewer, params[1], now);
    if (!found) throw new WebError(404, 'NOT_FOUND');
    return boardProjectPage(found, token, now);
  }),
  view('board-spec', 'viewer', new RegExp(`^/board/([\\w-]{1,200})/${KEY}/spec/(\\d{1,9})$`), ({ ctx, viewer, token, params, operator, now }) => {
    const key = params[1];
    const detail = viewer.keys.length > 0 && !viewer.keys.includes(key) ? null : specDetail(ctx, key, params[2], now);
    if (!detail) throw new WebError(404, 'NOT_FOUND');
    return specDetailPage(detail, { token, key, operator, now });
  }),
  call('board-job-log', 'viewer', new RegExp(`^/board/([\\w-]{1,200})/${KEY}/job/(\\d{1,9})/log$`), ({ ctx, viewer, params, query }) => {
    const key = params[1];
    const job = viewer.keys.length > 0 && !viewer.keys.includes(key) ? null : jobsStore.getJob(ctx.db, Number(params[2]));
    if (!job || job.project !== key) throw new WebError(404, 'NOT_FOUND');
    const offset = query.has('offset') ? Number(query.get('offset')) : null;
    return readJobLog(ctx, job, offset);
  }, GET),
  call('job-control', 'operator', /^\/api\/job\/(\d{1,9})\/(start|pause|stop)$/, ({ ctx, params, now }) => controlJob(ctx, params[0], params[1], now)),
];

function findRoute(pathname, search) {
  for (const route of ROUTES) {
    const match = pathname.match(route.path);
    if (match) return { route, token: match[1] ?? null, params: match.slice(1), query: new URLSearchParams(search) };
  }
  return null;
}

module.exports = { findRoute };
