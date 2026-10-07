import * as net from 'net';

/** macOS need not have 127.0.0.2; runners may have IPv6 disabled. */
export async function canBind(host: string): Promise<boolean> {
  const server = net.createServer();
  return new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(0, host, () => server.close(() => resolve(true)));
  });
}
