/**
 * **The BFF's one error-to-response rule.** Every `/api` route used to spell
 * `response.status(500).json({ error: errorMessage(error) })` for itself -
 * five copies of the same decision, each free to drift into a different body
 * shape. The routes now hand their work to {@link respondJson} and throw; what
 * a throw looks like on the wire is decided here and nowhere else.
 *
 * The one thing a route still decides is which failures are the caller's
 * fault: the very same `TerminalRequestError` is a 400 when starting a session
 * and a 409 when removing a running one, so that mapping arrives as
 * {@link RespondOptions.statusFor} rather than living on the error class.
 */

import type { Response } from 'express';

import { errorMessage } from '../../shared/utils/errors.js';

/** The body of every 404 the BFF answers; the UI only reads the status. */
const NOT_FOUND_BODY = { error: 'Not found' };

/**
 * "No such thing" raised from inside a {@link respondJson} producer - an
 * unknown run branch, say. A 404 is not a failure of the BFF, so it never
 * reaches the 500 mapping.
 */
export class NotFoundError extends Error {
  constructor(message = 'Not found') {
    super(message);
  }
}

export interface RespondOptions {
  /** Status for a body that was produced; 200 by default, 201 on a create. */
  status?: number;
  /**
   * The status for a failure the caller caused, by error type; `undefined`
   * (the default) means "not the caller's fault" and answers 500.
   */
  statusFor?: (error: unknown) => number | undefined;
}

/** Answers the BFF's standard 404, for a route that decides it before producing anything. */
export function respondNotFound(response: Response): void {
  response.status(404).json(NOT_FOUND_BODY);
}

/**
 * Answers `produce()` as JSON, or whatever it throws as `{ error }` with a
 * status. A producer that returns `undefined` acted without a body and gets a
 * 204, so a route that only mutates still reads as a single expression.
 */
export function respondJson(
  response: Response,
  produce: () => unknown,
  options: RespondOptions = {}
): void {
  let body: unknown;
  try {
    body = produce();
  } catch (error) {
    if (error instanceof NotFoundError) {
      respondNotFound(response);
      return;
    }
    response
      .status(options.statusFor?.(error) ?? 500)
      .json({ error: errorMessage(error) });
    return;
  }
  if (body === undefined) {
    response.status(options.status ?? 204).end();
    return;
  }
  response.status(options.status ?? 200).json(body);
}
