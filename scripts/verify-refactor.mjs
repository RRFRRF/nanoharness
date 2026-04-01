import { execSync } from 'node:child_process';

function run(command) {
  console.log(`\n$ ${command}`);
  execSync(command, { stdio: 'inherit' });
}

run('npm run typecheck');
run('npm run build');
run('npm --prefix container/agent-runner run build');
run(
  'npx vitest run src/container-runner.test.ts src/container-runner-provider.test.ts src/credential-proxy.test.ts src/config-provider.test.ts',
);
run('npx vitest run');
run('node scripts/smoke-container-build.mjs');

if (process.env.RUN_LIVE_SMOKE === '1') {
  run('node scripts/smoke-container-agent.mjs');
} else {
  console.log('\nSkipping live endpoint smoke. Set RUN_LIVE_SMOKE=1 to enable.');
}
