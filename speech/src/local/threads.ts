/**
 * How many CPU threads ONNX Runtime may use for one model run: at most four,
 * and two cores left for the rest of buddi (the gateway, Postgres, the
 * browser), never fewer than one. `SPEECH_THREADS` overrides it.
 */
import os from 'node:os';

export function speechThreads(env: NodeJS.ProcessEnv = process.env, cores: number = os.availableParallelism()): number {
  const set = Number.parseInt(env.SPEECH_THREADS ?? '', 10);
  if (Number.isFinite(set) && set >= 1) return Math.min(set, Math.max(1, cores));
  return Math.max(1, Math.min(4, cores - 2));
}
