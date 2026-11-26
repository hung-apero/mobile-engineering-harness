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
const { boardPage } = require('./page-board.cjs');
const { boardModel } = require('../board/model.cjs');

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
  view('board', 'viewer', /^\/board\/([\w-]{1,200})$/, ({ ctx, viewer, now }) => boardPage(boardModel(ctx, viewer, now), now)),
];

function findRoute(pathname, search) {
  for (const route of ROUTES) {
    const match = pathname.match(route.path);
    if (match) return { route, token: match[1] ?? null, params: match.slice(1), query: new URLSearchParams(search) };
  }
  return null;
}

module.exports = { findRoute };
