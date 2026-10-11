import path from 'node:path';
export function packageManagerInvocation(cli, args) {
  if (!cli) throw new Error('Run this script through pnpm.');
  // npm_execpath can be a JS shim or a native pnpm executable without a suffix.
  return /\.(?:cjs|mjs|js)$/i.test(path.basename(cli))
    ? { executable: process.execPath, args: [cli, ...args] }
    : { executable: cli, args };
}
