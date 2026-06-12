'use client';

import type { WsConnectionState } from '@/lib/ws/types';

const CONFIG: Record<WsConnectionState, { label: string; color: string; dot: string }> = {
  disconnected: { label: 'Disconnected', color: 'text-gray-400', dot: 'bg-gray-400' },
  connecting:   { label: 'Connecting…',  color: 'text-yellow-400', dot: 'bg-yellow-400 animate-pulse' },
  connected:    { label: 'Connected',    color: 'text-green-400',  dot: 'bg-green-400' },
  reconnecting: { label: 'Reconnecting…',color: 'text-orange-400', dot: 'bg-orange-400 animate-pulse' },
  resuming:     { label: 'Resuming…',    color: 'text-blue-400',   dot: 'bg-blue-400 animate-pulse' },
};

export function ConnectionStatus({ state }: { state: WsConnectionState }) {
  const { label, color, dot } = CONFIG[state];
  return (
    <div className={`flex items-center gap-2 text-xs font-mono ${color}`}>
      <span className={`w-2 h-2 rounded-full ${dot}`} />
      {label}
    </div>
  );
}
