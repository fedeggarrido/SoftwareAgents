// Real independent writers, with HOME isolated even on Windows. No Executor is launched.
require('os').homedir = () => process.env.HOME;
const { submitIdea } = require(process.argv[2]);
process.on('message', ({ root, text, interrupt }) => {
  if (interrupt) {
    const fs = require('node:fs');
    const write = fs.writeFileSync;
    fs.writeFileSync = (file, contents, ...options) => {
      if (typeof file === 'number' && contents === text) {
        write(file, 'interrupted draft', ...options);
        process.exit(73);
      }
      return write(file, contents, ...options);
    };
  }
  process.send(submitIdea({ projectId: 'ideas-project', requestId: 'child', text }, true, root));
  process.disconnect();
});
process.send({ ready: true });
