/**
 * Sobe o backend com o interpretador do ambiente virtual do projeto.
 *
 * O script antigo chamava `python` puro, que resolve para o interpretador
 * global. Isso funciona na maquina de quem tem o venv ativado no shell e
 * falha em todas as outras, com um ModuleNotFoundError no meio de um
 * stack trace do uvicorn - a primeira pedra no caminho de quem clona o
 * repositorio. Aqui o interpretador e escolhido explicitamente, e a
 * ausencia do venv vira uma mensagem que diz o que fazer.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const backend = join(raiz, 'agent_framework_backend');

const candidatos =
  process.platform === 'win32'
    ? [join(backend, '.venv', 'Scripts', 'python.exe')]
    : [join(backend, '.venv', 'bin', 'python3'), join(backend, '.venv', 'bin', 'python')];

const python = candidatos.find(existsSync);

if (!python) {
  console.error(
    [
      '',
      'Ambiente virtual do backend nao encontrado.',
      `Procurei em: ${candidatos.join(', ')}`,
      '',
      'Crie-o uma vez:',
      '  cd agent_framework_backend',
      '  python -m venv .venv',
      process.platform === 'win32'
        ? '  .\\.venv\\Scripts\\python.exe -m pip install -r requirements.txt'
        : '  ./.venv/bin/python -m pip install -r requirements.txt',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

const filho = spawn(
  python,
  ['-m', 'uvicorn', 'main:app', '--host', '0.0.0.0', '--port', '8000', '--reload'],
  { cwd: backend, stdio: 'inherit' },
);

filho.on('exit', (codigo, sinal) => {
  process.exit(sinal ? 1 : (codigo ?? 0));
});
