'use client';

import { useState } from 'react';
import { AgentProvider } from '@/store/agentStore';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { TraceTimeline } from '@/components/timeline/TraceTimeline';
import { ContextInspector } from '@/components/context/ContextInspector';

type Panel = 'timeline' | 'context';

export default function Home() {
  const [activePanel, setActivePanel] = useState<Panel>('timeline');

  return (
    <AgentProvider>
      <div className="flex h-full">
        {/* Main chat — 50% */}
        <div className="flex-1 min-w-0 flex flex-col">
          <ChatPanel />
        </div>

        {/* Right panel — 50% split into tab + content */}
        <div className="w-[600px] flex flex-col border-l border-zinc-800">
          {/* Tab bar */}
          <div className="flex border-b border-zinc-800 shrink-0">
            {(['timeline', 'context'] as Panel[]).map(panel => (
              <button
                key={panel}
                onClick={() => setActivePanel(panel)}
                className={`flex-1 py-2 text-xs font-semibold uppercase tracking-wide transition-colors ${
                  activePanel === panel
                    ? 'text-zinc-100 border-b-2 border-blue-500'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {panel === 'timeline' ? 'Trace Timeline' : 'Context Inspector'}
              </button>
            ))}
          </div>

          {/* Panel content */}
          <div className="flex-1 min-h-0">
            {activePanel === 'timeline' ? <TraceTimeline /> : <ContextInspector />}
          </div>
        </div>
      </div>
    </AgentProvider>
  );
}
