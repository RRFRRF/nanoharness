import { execSync } from 'node:child_process';

function run(command) {
  console.log(`$ ${command}`);
  execSync(command, { stdio: 'inherit' });
}

run('docker build -t nanoclaw-agent:latest -f container/Dockerfile container');
