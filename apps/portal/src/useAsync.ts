import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (data: T) => void;
}

/**
 * 비동기 조회 상태 관리
 * @param pollMs 값이 있으면 그 간격으로 다시 조회 (예: 문서 변환 진행 중)
 */
export const useAsync = <T>(
  load: () => Promise<T>,
  deps: unknown[],
  pollMs?: (data: T | null) => number | null,
): AsyncState<T> => {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(async () => {
    try {
      setData(await loadRef.current());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, deps);

  const interval = pollMs?.(data) ?? null;
  useEffect(() => {
    if (interval === null) return;
    const timer = setInterval(() => void reload(), interval);
    return () => clearInterval(timer);
  }, [interval, reload]);

  return { data, error, loading, reload, setData };
};
