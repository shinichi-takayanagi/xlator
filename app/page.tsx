"use client";

import { ConversationControls } from "@/app/components/conversation-controls";
import { SessionErrorToast } from "@/app/components/session-error-toast";
import { SiteHeader } from "@/app/components/site-header";
import { TranscriptPanel } from "@/app/components/transcript-panel";
import { useConversationSession } from "@/app/hooks/use-conversation-session";

export default function Home() {
  const session = useConversationSession();

  return (
    <main className="app-shell">
      <SiteHeader />

      <div className="workspace" id="top">
        <ConversationControls
          apiConfigured={session.apiConfigured}
          audioMode={session.audioMode}
          connectionStatus={session.connectionStatus}
          elapsed={session.elapsed}
          isListening={session.isListening}
          rows={session.rows}
          onAudioModeChange={session.setAudioMode}
          onStart={session.startConversation}
          onStop={session.stopConversation}
        />

        <div className="log-stack">
          <TranscriptPanel language="ja" rows={session.rows} />
          <TranscriptPanel language="en" rows={session.rows} />
        </div>

        <SessionErrorToast
          apiConfigured={session.apiConfigured}
          message={session.errorMessage}
          onDismiss={session.dismissError}
        />
      </div>
    </main>
  );
}
