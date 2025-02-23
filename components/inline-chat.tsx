'use client';
// 2025-01-25：实现内联对话框的基本功能
// 2025-02-02: 修复Vote功能
// TODO：内联对话框是通过新建一个新会话完成，但是若是去GET了History操作，则会显示出来在历史列表
//       现在是切换会话后就删除这个临时的

import { useChat } from 'ai/react';
import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useSWRConfig } from 'swr';
import { generateUUID } from '@/lib/utils';
import { Attachment } from 'ai';
import { MessageSquare, X } from 'lucide-react';
import useSWR from 'swr';
import { Vote } from '@/lib/db/schema';

import { MultimodalInput } from './multimodal-input';
import { BlockMessages } from './block-messages';
import { Messages } from './messages';
import { PreviewMessage } from './message';

interface InlineChatProps {
  isOpen: boolean;
  onClose: () => void;
  initialValue?: string;
  modelId?: string;
  id: string;
}

export function InlineChat({
  isOpen,
  onClose,
  initialValue = '',
  modelId = 'gpt-3.5-turbo',
  id,
}: InlineChatProps) {
  const { mutate } = useSWRConfig();
  const [attachments, setAttachments] = useState<Array<Attachment>>([]);
  const inlineChatId = useMemo(() => generateUUID(), [id]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { data: votes } = useSWR<Array<Vote>>(
    `/api/vote?chatId=${inlineChatId}`,
    (url: string) => fetch(url).then(res => res.json())
  );

  const {
    messages,
    setMessages,
    handleSubmit,
    input,
    setInput,
    append,
    isLoading,
    stop,
    reload,
  } = useChat({
    id: inlineChatId,
    body: { 
      id: inlineChatId, 
      modelId,
      saveHistory: true  // 使用 AI SDK 的内置保存功能
    },
    initialMessages: initialValue ? [{
      id: generateUUID(),
      role: 'user',
      content: initialValue
    }] : []
  });

  // 处理关闭事件 - 只关闭对话框
  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  // 处理路由切换时的清理
  useEffect(() => {
    return () => {  // 组件卸载时清理
      try {
        fetch(`/api/chat?id=${inlineChatId}`, {
          method: 'DELETE',
        });
      } catch (error) {
        console.error('Failed to delete inline chat:', error);
      }
      setMessages([]);
    };
  }, [inlineChatId, setMessages]);

  // 渲染所有消息，包括历史记录和当前流式内容
  const allMessages = useMemo(() => {
    return [
      ...messages,
    ];
  }, [messages]);

  // 处理点击外部关闭
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      handleClose();
    }
  };

  // 添加自动滚动函数
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  // 当消息更新时自动滚动
  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50" onClick={handleBackdropClick}>
      <div className="fixed inset-x-0 top-24 mx-auto max-w-2xl bg-background border rounded-lg shadow-lg flex flex-col max-h-[calc(100vh-8rem)] w-[90%] md:w-[80%]">
        {/* 对话框头部 */}
        <div className="flex items-center justify-between px-6 py-3 border-b flex-shrink-0">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4" />
            <span className="text-sm font-medium">内联对话框</span>
          </div>
          <button onClick={handleClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 消息列表 */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <Messages
            chatId={inlineChatId}
            messages={messages}
            isLoading={isLoading}
            votes={votes}
            setMessages={setMessages}
            reload={reload}
            isReadonly={false}
            isBlockVisible={false}
            disableScroll={true}
          />
          <div ref={messagesEndRef} />
        </div>

        {/* 输入框 */}
        <div className="px-6 py-4 border-t flex-shrink-0">
          <form className="flex gap-2 w-full" onSubmit={handleSubmit}>
            <MultimodalInput
              chatId={inlineChatId}
              input={input}
              setInput={setInput}
              handleSubmit={handleSubmit}
              isLoading={isLoading}
              stop={stop}
              attachments={attachments}
              setAttachments={setAttachments}
              messages={messages}
              setMessages={setMessages}
              append={append}
            />
          </form>
        </div>
      </div>
    </div>
  );
} 