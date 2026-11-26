const join = (base, kind, token) => `${String(base).replace(/\/+$/, '')}/${kind}/${token}`;

const quizUrl = (base, token) => join(base, 'quiz', token);
const reviewUrl = (base, token) => join(base, 'review', token);

module.exports = { quizUrl, reviewUrl };
