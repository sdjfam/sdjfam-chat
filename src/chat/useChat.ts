import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../types/chat";

export function useChat() {
  const [
    messages,
    setMessages,
  ] =
    useState<ChatMessage[]>([]);

  const messageListRef =
    useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const list =
      messageListRef.current;

    if(!list) {
      return;
    }

    list.scrollTop =
      list.scrollHeight;
  }, [messages]);
  return {
    messages,
    setMessages,
    messageListRef
  };
}
