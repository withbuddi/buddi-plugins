/**
 * A refusal before anything reached the app: the route's `precondition`
 * error (docs/browser.md, "A route a plugin provides"). buddi's runtime reads
 * `precondition: true` and looks again instead of pausing the task, and says
 * the sentence to the agent as it is.
 */
export class PreconditionError extends Error {
  readonly precondition = true;
  constructor(message: string) {
    super(message);
    this.name = 'PreconditionError';
  }
}

export const isPrecondition = (error: unknown): error is PreconditionError =>
  error instanceof Error && (error as { precondition?: unknown }).precondition === true;
