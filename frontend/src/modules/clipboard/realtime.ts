import { useEffect, useRef, useState } from 'react';
import { CLIPBOARD_CLIENT_ID, clipboardApi, type ClipboardEvent } from './api';

export function useClipboardEvents(
  onEvent: (event: ClipboardEvent) => void,
  enabled = true,
): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') {
      setConnected(false);
      return;
    }

    const es = new EventSource(clipboardApi.eventsUrl(CLIPBOARD_CLIENT_ID), {
      withCredentials: true,
    });

    const handleClipboardEvent = (raw: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(raw.data) as ClipboardEvent;
        if (parsed.client_id && parsed.client_id === CLIPBOARD_CLIENT_ID) {
          return;
        }
        handlerRef.current(parsed);
      } catch {
        // Ignore malformed payloads
      }
    };

    es.onopen = () => {
      setConnected(true);
    };

    es.onerror = () => {
      setConnected(false);
    };

    es.addEventListener('clipboard', handleClipboardEvent as EventListener);

    return () => {
      es.removeEventListener('clipboard', handleClipboardEvent as EventListener);
      es.close();
      setConnected(false);
    };
  }, [enabled]);

  return { connected };
}
