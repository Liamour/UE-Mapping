// Lightweight i18n — every UI string carries its own en/zh dict at the call
// site instead of being routed through a global message catalogue.  Keeps the
// translation co-located with the JSX that uses it (one fewer indirection
// when reading the source) and makes the language toggle "pure": flipping
// `useLLMStore.language` re-renders every component that called useT().
//
// Usage:
//   import { useT } from '../../utils/i18n';
//   ...
//   const t = useT();
//   <h2>{t({ en: 'Settings', zh: '设置' })}</h2>
//
// For non-React contexts (utility modules), call getLang() from useLLMStore
// directly.

import { useMemo } from 'react';
import { useLLMStore, type OutputLanguage } from '../store/useLLMStore';

export interface L10nMsg {
  en: string;
  zh: string;
}

export function useLang(): OutputLanguage {
  return useLLMStore((s) => s.language);
}

// Returns a memoised translator function.  The function reference is stable
// across re-renders of the same language — safe to put in useEffect deps if
// callers ever need to.
export function useT() {
  const lang = useLang();
  return useMemo(() => (msg: L10nMsg): string => msg[lang] ?? msg.en, [lang]);
}
