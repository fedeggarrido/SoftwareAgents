const os = require('os');
const fs = require('fs');
const path = require('path');
if (!process.env.HOME || process.env.USERPROFILE !== process.env.HOME)
  throw new Error('Isolated profile required');
os.homedir = () => process.env.HOME;
process.once('disconnect', () => process.exit());
fs.writeFileSync(path.join(process.env.HOME, `${process.pid}.process`), String(process.pid));
const runtime = require(process.argv[2]);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
process.on('message', async ({ role, iterations = 100 }) => {
  const errors = [];
  let acquired = 0;
  if (role === 'reader') {
    const timer = setInterval(() => {
      try {
        runtime.readSelectionSnapshot({ autonomyLevel: 'A1', allowedExecutors: ['codex'] });
      } catch (error) {
        errors.push(error.code || error.message);
      }
    }, 1);
    process.once('message', () => {
      clearInterval(timer);
      process.send({ errors });
      process.disconnect();
    });
    return;
  }
  const publisher = runtime.makePublisher();
  try {
    for (let i = 0; i < iterations; i++) {
      let slot;
      const deadline = performance.now() + 15000;
      while (!slot && performance.now() < deadline) {
        try {
          slot = runtime.withExecutorAdmission('codex', `${process.pid}-${i}`, (owner) => {
            const admission = path.join(process.env.HOME, 'admission-held');
            const fd = fs.openSync(admission, 'wx');
            try {
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
              return runtime.acquireExecutorSlot('codex', 1, owner);
            } finally {
              fs.closeSync(fd);
              fs.unlinkSync(admission);
            }
          });
        } catch (error) {
          errors.push(error.code || error.message);
        }
        if (!slot) await pause(1);
      }
      if (!slot) {
        errors.push(
          'acquisition deadline after ' +
            acquired +
            ': ' +
            fs
              .readdirSync(path.join(process.env.HOME, '.pixel-agents/executor-slots/codex'))
              .map(
                (n) =>
                  n +
                  '=' +
                  fs.readFileSync(
                    path.join(process.env.HOME, '.pixel-agents/executor-slots/codex', n),
                    'utf8',
                  ),
              )
              .join('|'),
        );
        break;
      }
      const sentinel = path.join(process.env.HOME, 'last-slot-held');
      let fd;
      try {
        fd = fs.openSync(sentinel, 'wx');
        slot.setSession(`${process.pid}-${i}`);
        publisher.publish();
        await pause(2);
        acquired++;
      } catch (error) {
        errors.push(error.code || error.message);
      } finally {
        if (fd !== undefined) {
          fs.closeSync(fd);
          fs.unlinkSync(sentinel);
        }
        try {
          slot.release();
        } catch (error) {
          errors.push(error.code || error.message);
        }
      }
    }
  } finally {
    publisher.dispose();
    process.send({ acquired, errors });
    process.disconnect();
  }
});
process.send({ ready: true });
