import { AppError } from "./errors";
import { canTransition, type StateTransition } from "./stateMachine";

export function assertTransition<TState extends string>(
  current: TState,
  next: TState,
  transitions: StateTransition<TState>[]
): void {
  if (!canTransition(current, next, transitions)) {
    throw new AppError(`Invalid transition from ${current} to ${next}`, "INVALID_TRANSITION", 409);
  }
}
