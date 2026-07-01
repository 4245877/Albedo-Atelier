export interface StateTransition<TState extends string> {
  from: TState;
  to: TState;
}

export function canTransition<TState extends string>(
  current: TState,
  next: TState,
  transitions: StateTransition<TState>[]
): boolean {
  return transitions.some((transition) => transition.from === current && transition.to === next);
}
