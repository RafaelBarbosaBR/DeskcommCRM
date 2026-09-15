"use client";

import { useSyncExternalStore } from "react";

import {
  getPrefsSnapshot,
  getPrefsSnapshotDoServidor,
  inscreverEmPrefs,
  type NotifyPrefs,
} from "@/lib/notifications/prefs";

/**
 * Lida no PRÓPRIO render, não num `useEffect` — mesmo defeito que
 * `useNotificationPermission` já resolveu para a permissão do navegador:
 * `useState(() => lerPrefs())` reexecuta o inicializador na hidratação, já
 * com `window`/`localStorage` de verdade, e diverge do HTML que o servidor
 * mandou (lá sempre o padrão) para quem mudou qualquer um dos ~10
 * interruptores desta tela.
 */
export function useNotifyPrefs(): NotifyPrefs {
  return useSyncExternalStore(inscreverEmPrefs, getPrefsSnapshot, getPrefsSnapshotDoServidor);
}
