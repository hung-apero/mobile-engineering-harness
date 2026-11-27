const KEY = /^[A-Z][A-Z0-9]+$/;
const PACKAGE = /^[a-z][a-z0-9_]*$/;
const APPLICATION_ID = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){2,}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const DISCORD_ID = /^\d{17,20}$/;
const TESTER_GROUP = /^[A-Za-z0-9_-]{1,60}$/;
const FIREBASE_PROJECT = /^[a-z][a-z0-9-]{3,29}$/;

const isText = value => typeof value === 'string' && value.trim() !== '';
const isName = value => isText(value) && value.length <= 60 && !/[\u0000-\u001f\u007f]/.test(value);

module.exports = { KEY, PACKAGE, APPLICATION_ID, REPO, DISCORD_ID, TESTER_GROUP, FIREBASE_PROJECT, isText, isName };
