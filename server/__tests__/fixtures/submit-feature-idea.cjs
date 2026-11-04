// Real independent writers, with HOME isolated even on Windows. No Executor is launched.
require('os').homedir = () => process.env.HOME;
const { submitIdea } = require(process.argv[2]);
process.on('message', ({ root, text }) => {
  process.send(submitIdea({ projectId: 'ideas-project', requestId: 'child', text }, true, root));
  process.disconnect();
});
process.send({ ready: true });
