// npm run build — сборка для production в папку dist/.
// TypeScript компилирует только .ts, поэтому SQL-миграции копируются отдельно:
// без них мигратор в dist/ не найдет, что применять.
// Тестовые данные и команды разработки в сборку не входят (tsconfig.build.json).
import { execFileSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

rmSync(dist, { recursive: true, force: true });
execFileSync(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.build.json')], { stdio: 'inherit' });
cpSync(path.join(root, 'src/db/migrations'), path.join(dist, 'src/db/migrations'), { recursive: true });

console.log(`Сборка готова: ${dist}`);
