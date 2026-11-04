// Real independent writers, with HOME isolated even on Windows. No Executor is launched.
require('os').homedir = () => process.env.HOME;
require('tsx/cjs');
const { submitIdea } = require('../../src/featureIdeas.js');
process.on('message', ({ root, text }) => {
  process.send(submitIdea({ projectId: 'ideas-project', requestId: 'child', text }, true, root));
  process.disconnect();
});
process.send({ ready: true });
