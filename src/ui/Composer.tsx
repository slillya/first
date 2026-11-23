// Bottom of the screen: Claude's latest reply in a small bubble, and the chat
// box. The box is one always-present textarea, so tapping it opens the
// keyboard natively; sending blurs it, which folds it back to a pill.
import { useEffect, useRef, useState } from "preact/hooks";
import { aiBusy, aiStatus, chat, liveReply, send, stop } from "../ai/agent";
import { ink, mode } from "../model/store";
import { Icon } from "./Icon";

export function ReplyBubble() {
  const msgs = chat.value;
  const busy = aiBusy.value;
  const last = msgs[msgs.length - 1];
  const [expanded, setExpanded] = useState(false);
  const [hidden, setHidden] = useState(false);

  // A finished reply lingers, then gets out of the way of the model.
  useEffect(() => {
    setHidden(false);
    if (busy || expanded || !last || last.role !== "assistant") return;
    const t = setTimeout(() => setHidden(true), 12_000);
    return () => clearTimeout(t);
  }, [msgs.length, busy, expanded]);

  if (expanded)
    return (
      <div class="history">
        <header>
          <strong>Conversation</strong>
          <button class="link" onClick={() => ((chat.value = []), setExpanded(false))}>
            Clear
          </button>
          <button class="round" aria-label="Close" onClick={() => setExpanded(false)}>
            <Icon name="close" size={18} />
          </button>
        </header>
        <div class="history-list" ref={(el) => {
            if (el) el.scrollTop = el.scrollHeight;
          }}>
          {msgs.map((m, i) => (
            <p key={i} class={`msg ${m.role} ${m.error ? "error" : ""}`}>
              {m.text}
            </p>
          ))}
          {busy && <p class="msg assistant live">{liveReply.value || aiStatus.value}</p>}
        </div>
      </div>
    );

  if (busy)
    return (
      <div class="reply live" role="status">
        <span class="spinner" />
        <span class="reply-text">{liveReply.value || aiStatus.value}</span>
      </div>
    );
  if (!last || last.role !== "assistant" || hidden) return null;
  return (
    <button class={`reply ${last.error ? "error" : ""}`} onClick={() => setExpanded(true)}>
      <Icon name="sparkle" size={16} />
      <span class="reply-text">{last.text}</span>
    </button>
  );
}

export function Composer() {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const busy = aiBusy.value;
  const sketching = mode.value.kind === "sketch";
  const hasInk = sketching && ink.value.length > 0;
  const canSend = !busy && (text.trim().length > 0 || hasInk);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = focused ? `${Math.min(el.scrollHeight, 132)}px` : "";
  }, [text, focused]);

  const submit = () => {
    if (!canSend) return;
    const t = text;
    setText("");
    box.current?.blur();
    void send(t);
  };

  const placeholder = busy
    ? "Claude is working…"
    : hasInk
      ? "Say what this is, or just send"
      : sketching
        ? "Describe what to draw…"
        : "Describe a part or a change…";

  return (
    <div class={`composer ${focused ? "open" : ""}`}>
      <Icon name="sparkle" size={18} class="composer-icon" />
      <textarea
        ref={box}
        rows={1}
        value={text}
        placeholder={placeholder}
        enterkeyhint="send"
        autocomplete="off"
        autocapitalize="sentences"
        onInput={(e) => setText(e.currentTarget.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      {busy ? (
        <button class="round" aria-label="Stop" onClick={stop}>
          <Icon name="stop" size={16} />
        </button>
      ) : (
        (canSend || focused) && (
          // pointerdown would blur the textarea before click fires; keep focus until we decide.
          <button class="round primary" aria-label="Send" disabled={!canSend} onPointerDown={(e) => e.preventDefault()} onClick={submit}>
            <Icon name="send" size={18} />
          </button>
        )
      )}
    </div>
  );
}
