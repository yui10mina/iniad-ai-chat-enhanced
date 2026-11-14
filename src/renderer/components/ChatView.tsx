import React, { useRef, useEffect } from "react";
import type { ChatProgress, ChatTurn } from "../../shared/types/chat";
import { chatProgressLabel } from "../chat-progress-label";
import { MessageBubble } from "./MessageBubble";

interface ChatViewProps {
  messages: ChatTurn[];
  isLoading?: boolean;
  /** 回答の生成中に Main から届いた最新の進捗 */
  progress?: ChatProgress | null;
}

export const ChatView: React.FC<ChatViewProps> = ({ messages, isLoading, progress }) => {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  return (
    <div className="chat-view-container">
      {messages.length === 0 && !isLoading ? (
        <div className="chat-empty-state">
          <p>質問を入力して会話を始めましょう</p>
        </div>
      ) : (
        messages.map((msg) => <MessageBubble key={msg.id} turn={msg} />)
      )}

      {isLoading && (
        <div className="thinking-indicator">
          <div className="thinking-avatar">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="11" width="18" height="10" rx="2"></rect>
              <circle cx="12" cy="5" r="2"></circle>
              <path d="M12 7v4"></path>
              <line x1="8" y1="16" x2="8" y2="16"></line>
              <line x1="16" y1="16" x2="16" y2="16"></line>
            </svg>
          </div>
          <div className="thinking-body">
            <div className="thinking-sender-name">AI アシスタント</div>
            <div className="thinking-bubble">
              <span className="thinking-dot"></span>
              <span className="thinking-dot"></span>
              <span className="thinking-dot"></span>
            </div>
            <div className="thinking-status" role="status" aria-live="polite">
              {chatProgressLabel(progress)}
            </div>
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
};
