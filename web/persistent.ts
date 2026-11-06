import React, { useEffect, useState } from "react";

/**
 * State that survives reloads and hot updates in this browser. Storage can be unavailable
 * (private mode, blocked site data); the state then simply starts from its default.
 */
export function usePersistent<T>(key: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`devlog.${key}`);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(`devlog.${key}`, JSON.stringify(value));
    } catch {
      /* not persisted */
    }
  }, [key, value]);
  return [value, setValue];
}
