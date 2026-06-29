import { useEffect, useRef } from 'react';

/** A ref that always holds the latest value — for use inside effects/listeners
 *  without re-subscribing on every render. */
export function useCallbackRef<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}
