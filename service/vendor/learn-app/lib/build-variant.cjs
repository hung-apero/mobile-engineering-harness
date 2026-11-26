const S = require('./learn-app-state.cjs');
const { fail, print } = require('./cli-io.cjs');

function variant(root, name) {
  if (!name || !/^[a-z][A-Za-z0-9]*$/.test(name)) fail('Cần tên variant Gradle, ví dụ devDebug, hoặc appDevDebug khi app có 2 flavor dimension');
  const state = S.readState(root);
  state.buildVariant = name;
  S.writeState(root, state);
  print({ buildVariant: name, buildCommand: `node ${require('path').join(__dirname, '..', 'bin', 'build.cjs')} --root <App root>`, gradleTask: `:app:assemble${name[0].toUpperCase()}${name.slice(1)}` });
}

module.exports = { variant };
