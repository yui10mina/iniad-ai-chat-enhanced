import React, { useState, useCallback, useRef, useEffect } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChatTurn } from "../../shared/types/chat";
import { CitationPanel } from "./CitationPanel";

interface MessageBubbleProps {
  turn: ChatTurn;
}

/** リンクはアプリ内遷移させず、Main プロセスの許可判定を通して外部ブラウザーで開く */
const markdownComponents: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      title={href}
      onClick={(event) => {
        event.preventDefault();
        if (href && href.startsWith("https://")) {
          void window.electronAPI.openExternalUrl(href).catch(() => false);
        }
      }}
    >
      {children}
    </a>
  ),
};

export const MessageBubble: React.FC<MessageBubbleProps> = ({ turn }) => {
  const isUser = turn.role === "user";
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const handleCopy = useCallback(async () => {
    if (!turn.content) return;
    let success = false;
    try {
      await navigator.clipboard.writeText(turn.content);
      success = true;
    } catch {
      try {
        const textarea = document.createElement("textarea");
        textarea.value = turn.content;
        document.body.appendChild(textarea);
        textarea.select();
        success = document.execCommand("copy");
        document.body.removeChild(textarea);
      } catch {
        success = false;
      }
    }
    setCopied(success);
    if (success) {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 1500);
    }
  }, [turn.content]);

  return (
    <div className={`message-bubble-wrapper ${isUser ? "user" : "assistant"}`}>
      <div className="message-avatar">
        {isUser ? (
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
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
            <circle cx="12" cy="7" r="4"></circle>
          </svg>
        ) : (
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
        )}
      </div>
      <div className="message-body">
        <div className="message-sender-name">{isUser ? "あなた" : "AI アシスタント"}</div>
        <div className={`message-bubble ${isUser ? "user" : "assistant"}`}>
          {isUser ? (
            <p className="message-content">{turn.content}</p>
          ) : (
            <div className="message-content markdown">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                disallowedElements={["img"]}
                components={markdownComponents}
              >
                {turn.content}
              </ReactMarkdown>
            </div>
          )}

          {!isUser && <CitationPanel citations={turn.citations || []} />}

          <button
            className={`message-copy-button ${copied ? "copied" : ""}`}
            onClick={handleCopy}
            title="コピー"
            aria-label={copied ? "コピーしました" : "メッセージをコピー"}
          >
            {copied ? (
              <svg
                aria-hidden="true"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            ) : (
              <svg
                aria-hidden="true"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
