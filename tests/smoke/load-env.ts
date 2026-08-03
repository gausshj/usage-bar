import nextEnv from '@next/env';
import type { Env } from '@next/env';

const strictLogger = {
  info: () => undefined,
  error: (...args: unknown[]): never => {
    const cause = args.find((arg): arg is Error => arg instanceof Error);
    throw cause ?? new Error('Failed to load smoke environment');
  },
};

/** Load one env file with the same dotenv + expansion semantics as Next. */
export function loadSmokeEnv(
  contents: string,
  directory: string,
  path = '.env.local',
): Env {
  const loadedFile = { path, contents, env: {} as Env };
  nextEnv.processEnv([loadedFile], directory, strictLogger, true);
  return loadedFile.env;
}
