// Настройки сервера из переменных окружения. Перечень переменных — в server/.env.example.
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Папка server/ — от нее считаются относительные пути, откуда бы ни запускалась команда. */
export const SERVER_ROOT = path.resolve(import.meta.dirname, '..');

const envFile = path.join(SERVER_ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

/** Значение переменной; пустая строка считается незаданной. */
function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

const nodeEnv = env('NODE_ENV') ?? 'development';
if (!['development', 'test', 'production'].includes(nodeEnv)) {
  throw new Error(`NODE_ENV=${nodeEnv}: допустимы development, test, production`);
}

export const config = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  databasePath: path.resolve(SERVER_ROOT, env('DATABASE_PATH') ?? 'data/nogotochki.db'),
  seed: {
    adminPassword: env('SEED_ADMIN_PASSWORD'),
    clientPassword: env('SEED_CLIENT_PASSWORD'),
  },
};
